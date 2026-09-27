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
| `/var/lib/qorpera/identities/<id>` | root, one mount each | attached Compute Identity volumes |
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
  hosts to end, then rebuild.

## Installing an execution host (pilot runbook, node 2)

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

The node's inventory observer pins the host's configuration digest (it
includes the `image.*` keys), so a rebuild makes the node `unavailable` for
placement and logins until the inventory policy is re-enrolled: recompute the
digest from `lxc query /1.0/instances/<vm>?project=<project>` (type, profiles,
config and expanded config without `volatile.*` keys, devices and expanded
devices; sorted-key compact JSON), replace the policy with
`qorpera_replace_runtime_node_inventory(policy, previous_sha256)`, write the
observer configuration and restart the observer. The host may carry no
`user.qorpera.*` key other than `user.qorpera.management_vm`.

A new member login on the node creates a new identity volume: attach it to
the execution host (`lxc config device add …`, hot-pluggable for a running
VM) before that member's first run; the service refuses a run whose identity
is not mounted.

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
