# Qorpera Runner Orchestrator

The standalone node observer has its own protected package and installer, independent of clients and office guests. See [node observer installation](../../deploy/first-node/NODE-OBSERVER-INSTALLATION.md) for reviewed inputs, read-only checks, inactive installation, immutable recovery and enrollment boundaries. Its offline actual-systemd proof covers the installed service with zero capabilities and TLS polling; production host acceptance remains separate.

Explicit office recovery is read from the root-protected sibling `${planPath}.recovery`, using the closed envelope `{ "schema": "qorpera.lxd-office-recovery-plan/v1", "request": <CompanyComputerLifecycleRequest> }`. The request binds the current activation, provider policy, allocation, boot and service invocation. Supply it only for an explicitly requested lifecycle transition. The supervisor requires its retained activation phase and serializes the stop and successor workers under the same kernel lock. Keep this plan through process recovery; each completed request remains in immutable provider history, and a subsequent transition needs a new transition ID and the current activation/invocation.

The worker retains recovery intent before SQL revocation, then one stop request and dispatch journal. Unknown submission is observation only. After reading protected guest completion, it issues a fresh SQL challenge and a separately journaled nonce inspection; one monotonic window covers inspection through acknowledgement. Replacement providers recover committed acknowledgement through status. Cancellation keeps the process slot until underlying SQL IO settles. Each transition permits at most 64 inspection attempts; timeout never erases evidence or resets that budget.

A `held` observation with `phase: "service_stop"` and `acknowledgedAtMs` reports the historical acknowledgement for `replace`. Physical replacement and capacity release remain unimplemented. Recovery uses retained activation and installed public metadata; it does not inspect mutable workbench copies or credential secrets. Local `node scripts/test-runtime-office-start.mjs --stop-worker` acceptance joins the actual supervisor, worker, Unix HTTP transport and disposable PostgreSQL; physical guest/systemd measurements in that fixture are synthetic.

For `power_off` or the shutdown stage of `reboot`, acknowledged service shutdown advances into a separate VM shutdown phase. `LxdOfficePowerOffWorker` retains boot/activation/stop history before guest access disappears, rechecks current SQL stop authority, and submits one non-forced LXD stop through the existing durable VM journal. Known operations recover through observation; unknown submissions remain unresolved and never retry. A `powered_off` observation with `phase: "power_off"` requires the exact retained VM to be stopped in both instance and state observations. The root disk, attached workbench and company allocation remain intact, with SQL admission in maintenance. After the confirmed stop of an explicit `power_off` (never the shutdown stage of `reboot`), the worker calls `qorpera_suspend_runtime_node_machine` before reporting `powered_off`: the node demand stays placed but no longer counts, so the slot is free until resume re-admits it through the ordinary node reservation. While the demand is suspended every call returns the same receipt. A demand that still counts is kept (`RESUME_PENDING`) once a boot intent for this power-off or any later lifecycle transition exists, which includes every call after resume re-admitted it. A new external boot cannot reuse the old shutdown command. Retain the protected recovery plan and forward stage. `--power-off-worker` covers this provider/SQL/Unix HTTP flow with synthetic VM power measurements, including lost operation polling, database restart and refusal of a missing forward stage, and checks that the node then counts no computer and offers the free slot to placement while the suspended demand stays on its node; `--resume-worker` and `--vm-cycles` check that resume re-admits it and that the same suspension is then kept.

For explicit VM resume, retain `${planPath}.resume` as the root-protected envelope `{ "schema": "qorpera.lxd-office-resume-plan/v1", "request": <CompanyComputerBootIntentRequest> }`, bound to the same predecessor recovery request. Populate its stop-history digest from the verified v2 (original boot) or v3 (later boot) power-off request and its power-off digest from the exact completion bytes. Prior v1 shutdown journals cannot manufacture this proof. Before shutdown, every protected root-history blob is read and hashed; the original manifest bytes are retained separately. The supervisor records a forward boot stage after confirmed VM shutdown, then `LxdOfficeResumeWorker` prepares/checks current SQL intent authority and starts once through the complete retained create/start/stop sequence. Accepted operations recover; unknown submissions never retry. The observed kernel boot must be distinct and the root archive must still match. The result is `awaiting_configuration`, with original credentials and adoption evidence preserved. Missing or changed forward stages, plans, metadata or boot observations fail closed. `--resume-worker` joins the supervisor, workers, real PostgreSQL and Unix HTTP with synthetic VM boots/archives, clears the synthetic `/run` inbox, and proves lost intent/poll/database recovery while retaining one allocation.

For `service_restart`, the supervisor retains a forward stage after acknowledged stop and returns `progressed`. The next tick selects `LxdOfficeSuccessorWorker`, which persists a distinct activation before SQL preparation, requires fresh enabled dispatch authority and submits one protected root restart. An existing dispatch can only be observed. Readiness and nonce-bound physical inspection share a finite deadline through SQL activation. Immutable per-activation completion records support subsequent stop/restart cycles without replacing original history. Active polls use the supervisor's current-process observation; a new process inspects again. Preparation disable permits stop and already-active recovery but refuses a new restart.

`LxdOfficeSuccessorControl` keeps metadata recovery separate from its current authority check. Preparation requires an acknowledged predecessor stop, current provider authority and fully drained surfaces; it retains the same allocation/configuration and private state with a new activation identity. Current privacy/drain changes fence readiness and activation. The `--successor-admission` SQL acceptance mode covers the adapter and headless startup handshake. `--successor-worker` joins the concrete supervisor, workers and Unix HTTP transport with PostgreSQL across two restart cycles, lost physical/committed SQL replies and database restart. Guest/systemd measurements in these SQL fixtures are synthetic; `--successor-systemd` covers the protected controls with actual systemd as described below.

`LxdOfficeBootIntentControl` prepares one explicit reboot/resume intent after independently verified shutdown and protected stop history. Persist the request before submission; its planned activation and two shutdown digests are immutable. Prepare/status recover metadata while the provider is disabled or the company paused. Only `check` grants a bounded current SQL authority window, with RPC latency deducted. The VM worker must use that window for physical verification and journaled dispatch, preserving unknown submissions instead of retrying. The three RPCs are provider-only. An intent whose post-boot handoff exists reports `admitted` and cannot authorize another VM start; that state does not imply ordinary-service activation.

`LxdOfficeBootSuccessorControl` provides separate SQL admission for an independently observed new boot after `reboot` or explicit resume from `power_off`. Its closed request binds `bootIntentId`, stop-history, VM-shutdown and boot-observation digests plus a fresh activation/boot/configuration. SQL requires the exact pre-boot intent and its unchanged privacy/office snapshot, keeps the original preparation observation, allocation and historical activations, refuses reused boot/configuration/receipt identities, and requires current provider/pause/drain authority before readiness and activation. The `--boot-successor-admission` mode tests two new boots with synthetic physical evidence and real PostgreSQL/headless adapters, including competing pre-boot intents and reply/database recovery. The supervisor does not automatically resume powered-off machines.

After `LxdOfficeBootConfigurationWorker` acknowledges the protected receipt and six selected credentials, the supervisor retains a separate `boot_activation` stage. `LxdOfficeBootActivationWorker` reads the completed creation, preparation, shutdown, resume and configuration records without calling earlier phase workers. It stores the exact successor request before SQL preparation, retains prepared metadata after a lost reply and stages one public root-start packet. Every effect rechecks the kernel lock, original records, protected stop archive, selected receipt/claim/credentials, current host and guest boot, and current SQL authority. Unknown start submission never retries. Matching readiness and a separately journaled nonce inspection share one five-second window through SQL activation. Active recovery in a new provider process inspects again; routine polls in the same process retain its observation. The `--resume-worker` acceptance composes this first retained-VM resume with real SQL/Unix HTTP and synthetic VM/root measurements, then explicitly stops the new invocation through a second revocation and acknowledgement. Lost replies and database/provider restart preserve the same allocation and prior records.

`LxdOfficeServiceStopWorker` selects that resumed boot and subsequent same-boot service activations through `readLxdOfficeRetainedActivationHistory`. Historical predecessor, shutdown/resume, configuration and boot-successor records retain their actual schemas; public configuration and root claim/completion readback bind the current boot. Stop does not resolve credential secrets, revalidate copied workbench contents, or call boot intent/preparation again. The original stop, nonce inspection and SQL acknowledgement protocol remains authoritative, leaving maintenance and charged capacity in place.

After that stop, `LxdOfficeSuccessorWorker` selects the fixed `boot-service-restart` protocol. Its packet retains the original immutable boot-start request and the actual prepared service successor, with separate completion and inspection schemas. Per-activation dispatch journals bind boot intent, original activation, predecessor stop and configuration. The shared inspection implementation preserves the original boot-start wire format and its five-second deadline through readiness and SQL activation. Later stops require the new activation's exact packet, claim, acknowledgement and root completion. Unknown dispatches never retry. `--resume-worker` also covers two complete service restart/stop cycles on this boot, with lost committed replies and database/provider recovery. Later VM cycles use the immutable history described below.

Later VM power-off requests use `qorpera.lxd-office-power-off-request/v3` and retain the boot intent that produced the selected boot. The history reader walks those immutable shutdown/resume links back to the original v2 shutdown, validates each receipt, manifest, resume observation and protected record digest, and derives the full command sequence. Its fixed limit matches the 128-command operation journal. Current journal validation refuses an older prefix after any later command, including an unknown dispatch. Every new boot must differ from all retained earlier boots; host-boot continuity remains mandatory. Each shutdown stores only its immediate evidence while the verifier rechecks the complete history, so retained record lists do not grow with each VM cycle. Configuration and activation retain permanent original preparation rather than requiring it to belong to the immediately preceding boot. Named worker tests compose two further VM cycles and cover a service successor as the shutdown predecessor, changed history, lost replies and prior-boot reuse. VM, root and SQL responses in these worker tests are synthetic. `node scripts/test-runtime-office-start.mjs --vm-cycles` adds actual PostgreSQL, Unix HTTP and supervisor acceptance: after the first resumed boot and two service restarts, it completes two further VM shutdown/resume/configuration/activation cycles. Each intent, successor preparation, activation, revocation and stop acknowledgement loses its first committed response; each accepted VM/configuration operation loses its first poll. Database restarts and fresh provider instances recover the exact commands. The test requires six activation histories, six stops, three admitted boot intents, one current activation and one charged allocation in maintenance. It also refuses a superseded historical boot plan without new effects and verifies previous persistent bytes through both cycles. VM/root/workload effects remain synthetic; combined new-boot SQL/root acceptance remains required.

`--successor-systemd` runs that same provider/SQL sequence against packaged protected controls in a disposable systemd guest. Select an already prepared digest-pinned `QORPERA_OFFICE_SYSTEMD_TEST_IMAGE`. The isolated guest uses real root files, kernel flock, service invocation IDs and cgroups; the test confirms detached descendant cleanup and retained history/workbench bytes through two restart cycles. Image installation also runs its actual-systemd checks. VM creation/boot, the host/NAS gate, copied inventory and ordinary office workload remain synthetic, and the fixture reports readiness using the real measured invocation. This is combined root-control/SQL acceptance, not complete office workload, KVM or NAS acceptance. Both disposable containers are removed on completion or failure.

`--boot-successor-systemd` combines actual PostgreSQL admission adapters with packaged new-boot configuration, service start, two explicit restarts and three stops. A fresh systemd guest supplies its actual boot ID and persistent filesystem; historical preparation and the first stop are declared fixtures bound to the original SQL activation. Preparation never runs on the new boot. The proof requires six loaded boot credentials, distinct service invocations, descendant cleanup, preserved historical files/workbench bytes and ten lost committed SQL replies recovered through database restarts. SQL retains four activation histories, four stop receipts, one current activation and one charged allocation in maintenance. This mode calls admission adapters and root controls directly: the complete LXD worker chain pins `virtiofs`/`lxd_workbench` and requires the actual VM environment. It does not substitute a mount identity or relax production checks. VM observations, prior copy and ordinary workload remain synthetic. Disposable containers and the owned workbench volume are removed on completion or failure.

This package is the future deployable dispatch bridge between the durable
Qorpera control plane and disposable agent computers. It has no Electron
dependency. Supabase remains the canonical scheduler and orchestration
authority; this service can mutate work only through the scoped Supabase
contract.

The dispatcher continuously asks Supabase to reconcile durable schedule cursors
and expired leases, transactionally claims immutable runs up to a bounded
provider capacity, asks a provider adapter for compatible isolated computers,
and delivers short-lived assignment capabilities out of band. Supabase
notifications may wake the loop, but reconciliation against durable Supabase
state is the correctness path.

`LocalCloudRunnerProviderAdapter` is the development/test adapter. It proves the
dispatch contract but is not part of the step-1 production cloud. A step-2
production deployment must provide an adapter that provisions, monitors, and
recycles Qorpera-managed execution infrastructure; publishing this package
alone does not provide all-machines-offline execution.

The package also builds the historically named `qorpera-runner-orchestrator`
service executable.
It connects the private Supabase control-plane endpoint to an independently
deployed runner-provider endpoint over the `qorpera.runner-provider/v1`
contract. The provider endpoint owns VM/container lifecycle and assignment
delivery; the orchestrator does not import Electron or desktop credentials.
Each `acquire` request carries the immutable execution run ID as
`acquisition_id`. Providers must make acquisition idempotent by that ID and
return/reconcile the same provisioned runner after a lost response instead of
creating duplicate computers.

The included process provider starts a native-provider sidecar beside each
provisioned runner. The sidecar and runner share only that computer's private
checkout paths; the runner receives a short-lived loopback capability and never
receives the provider OAuth credential. A managed-VM adapter must preserve this
co-location boundary inside the provisioned computer. The public hosted
`native-provider-login` function forwards official login authority only and is
not an execution proxy.

The included LXD provider is the Step 2 host adapter. It talks only to LXD's
local Unix socket, always submits `type: virtual-machine`, and rejects the
Step 3 `company_computer` worker class. Before creating a guest it durably binds
the immutable run ID to the provisioned runner, exact image fingerprint,
project, profile, storage pool, Compute Identity volume, post-boot bootstrap
digest, and compute-policy digest. After the VM is running, the provider uses
the authenticated local LXD agent API to install root-owned mode-0600 bootstrap
files and start the fail-closed bootstrap unit. No secret is placed in
cloud-init or LXD instance configuration; the journal contains only hashes. A
provider restart adopts a matching VM instead of duplicating it, while missing
or drifted VMs fail closed.
Stopping a runner powers the VM off without deleting it so unpublished
canonical output is not silently discarded.

Each Compute Identity receives one persistent custom filesystem volume. Login
and job VMs for that identity mount the same volume, while the provider cannot
read its per-identity capsule master key. Loss of that volume currently means
loss of the key and therefore loss of access to its encrypted capsules. Signed,
NAS-backed key recovery must be completed and tested before the node is treated
as replaceable or production-ready; the provider deliberately has no local
fallback authority.

Native subscription execution through the process provider additionally
requires `QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY=virtual_machine` (or
`microvm`). This asserts that the provider service itself is running inside the
dedicated machine boundary. An unspecified/local host process is deliberately
not accepted as a production execution boundary, and one process-provider
instance admits only one acquisition at a time. This is an application
isolation assertion, not a claim that an infrastructure administrator is
cryptographically blind before confidential/attested compute is deployed.

Required service configuration:

- `QORPERA_SUPABASE_URL`
- `QORPERA_SUPABASE_PUBLISHABLE_KEY`
- `QORPERA_RUNNER_ORCHESTRATOR_ID`
- `QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN`
- `QORPERA_RUNNER_ORCHESTRATOR_CONTROL_STATE` (absolute private state-file path)
- `QORPERA_RUNNER_PROVIDER_URL`
- `QORPERA_RUNNER_PROVIDER_ADAPTER`
- `QORPERA_RUNNER_PROVIDER_TOKEN`

`npm run pack:runner-orchestrator` emits the standalone service as a
checksum-manifested single-file artifact. The first-node installer places it in
the dedicated management VM under a hardened systemd unit and leaves it
disabled until the root-owned environment file and provider CA certificate are
installed. The management VM connects to the host provider over HTTPS; the
provider independently source-fences the VM's anti-spoofed bridge address.

The process provider additionally requires:

- `QORPERA_SUPABASE_SERVICE_KEY`
- `QORPERA_EPHEMERAL_RUNNER_MODULE`
- `QORPERA_NATIVE_PROVIDER_MODULE`
- `QORPERA_NATIVE_PROVIDER_MASTER_KEY_FILE` (an infrastructure-mounted 32-byte base64url capsule key; only the native host reads it)
- `QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY`
- `QORPERA_RUNNER_PROVIDER_STATE_ROOT`
- `QORPERA_RUNNER_PROVIDER_TEMPORARY_ROOT`
- `QORPERA_EPHEMERAL_RUNNER_IMAGE`
- `QORPERA_EPHEMERAL_RUNNER_IMAGE_ARCHIVE_SHA256`
- `QORPERA_EPHEMERAL_RUNNER_IMAGE_COSIGN_BUNDLE_SHA256`
- `QORPERA_EPHEMERAL_RUNNER_PODMAN`
- `QORPERA_EPHEMERAL_RUNNER_ENTRYPOINT`

Set `QORPERA_RUNNER_PROVIDER_BACKEND=lxd` to select the LXD provider. Its
configuration is documented in
`deploy/first-node/lxd-provider.env.example`. The image fingerprint must name a
pinned local (`QORPERA_LXD_IMAGE_SERVER=local`) or HTTPS-remote guest image
containing `qorpera-lxd-runner-bootstrap.service`; that root-owned bootstrap
service validates the Compute Identity volume, the separate runner/native
accounts, and the private credential sources before systemd exposes each
credential only to its intended service. A plain Ubuntu image is not accepted
as an execution image merely because it can boot.

The LXD host can be provisioned while the NAS is offline. A real functional
acceptance run may also use the explicitly configured Supabase-primary storage
profile, which exercises durable capsules, checkpoints, substrates, and
publication without mocks. Production remains NAS-primary with Supabase backup;
in that mode an unavailable NAS fails closed instead of silently changing
authority.

For the first node, `npm run pack:lxd-provider` emits the Node.js service, a
provenance tool, and a SHA-256 manifest under `.artifacts/lxd-provider`. The host
installer in `deploy/first-node/install-lxd-provider-host.sh` installs that
artifact and the hardened systemd unit, verifies LXD socket access as the
dedicated provider account, and deliberately leaves the unit disabled while
`/etc/qorpera/lxd-provider.env` is absent. Copy and populate the example only
after the pinned signed guest image and real control-plane secrets exist; do not
enable the unit with placeholders.

The LXD backend will not start unless an Ed25519-signed provenance envelope and
its separately provisioned public trust root authorize the exact configured
image fingerprint, locked guest-package manifest, immutable nested OCI runner
image, private archive digest, and retained Cosign-bundle digest. The statement
also binds the base image, clean source commit, retained clean-boot evidence,
KVM, UEFI Secure Boot, and the no-credential fail-closed acceptance conditions.
Mutable LXD aliases and image properties are not authorization. The signing
private key must remain off the compute node. See
`deploy/first-node/README.md` for the activation and recovery gates.

`deploy/first-node/verify-lxd-vm-boundary.sh` is a disposable hardware smoke
test. It downloads an official Ubuntu 26.04 image, boots one 2-vCPU full VM on
the configured ZFS pool, verifies KVM, UEFI Secure Boot, the private runner
subnet, DNS egress, and the LXD guest agent, records the exact base-image
fingerprint, then removes only its marker-owned smoke VM. Passing this test does
not turn that mutable official image alias into the signed Qorpera guest image.

`npm run pack:lxd-runner-guest -- --signed-runner-image <artifact-directory>`
builds the locked guest payload and embeds the previously verified private OCI
archive. The guest preloads the immutable image into the rootless runner store;
runtime uses `--pull=never` and does not retain registry credentials.
`deploy/first-node/build-lxd-runner-image-candidate.sh` installs it into a
temporary full VM and publishes a local immutable `unsigned-candidate` image.
`deploy/first-node/verify-lxd-runner-image-candidate.sh` clean-boots that exact
fingerprint with no credentials or identity volume, verifies the signed-boundary
prerequisites and pinned harnesses, and proves the services fail closed. These
steps are NAS-independent, but they do not provide signed provenance and do not
authorize enabling the provider.

`QORPERA_CODEX_PATH` and `QORPERA_CLAUDE_PATH` may select the installed official
CLI binaries. The same capsule master key must be configured on the login
service and the isolated native sidecars. This is an application boundary, not
a claim that an infrastructure administrator cannot inspect an unattested VM.
The standalone login service requires `QORPERA_SUPABASE_URL`,
`QORPERA_SUPABASE_SERVICE_KEY`, `QORPERA_NATIVE_PROVIDER_MASTER_KEY_FILE`,
`QORPERA_NATIVE_PROVIDER_BRIDGE_TOKEN`, and the same explicit
`QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY`. Configure the hosted
`native-provider-login` function's `QORPERA_NATIVE_PROVIDER_UPSTREAM_URL` to
that service's HTTPS endpoint. The login service must run inside the declared
dedicated VM or microVM boundary; a developer host process is not a production
Member Compute Identity.

`QORPERA_RUNNER_ORCHESTRATOR_POLL_MS` optionally controls how often the service
asks for new work (default 250 ms). `QORPERA_RUNNER_ORCHESTRATOR_RECONCILE_MS`
controls how often it renews control, runs the occurrence reconcilers, reconciles
expired claims and the provider, and re-reads its retained claims (default 2 s);
a failed reconcile blocks claims and is retried on the next poll.
`QORPERA_RUNNER_ORCHESTRATOR_CONCURRENCY` controls the
bounded concurrent dispatcher (default 8, maximum 64). The service deliberately
has no desktop fallback.

The bootstrap orchestrator token is used only when the control-state file does
not exist. The service persists a pending replacement before rotation, sends
only its SHA-256 hash to the control plane, and can replay a lost rotation
response under the already-installed replacement. Protect and durably mount the
state file for the orchestrator service account; losing both it and the current
server authority requires an operator re-enrollment. This token authorizes only
orchestration control and is not a provider or member subscription credential.

The headless office provider's reviewed installation inputs, credential custody,
systemd lifecycle and reproducible local acceptance command are documented in
[OFFICE-PROVIDER-INSTALLATION.md](../../deploy/first-node/OFFICE-PROVIDER-INSTALLATION.md).
Installation leaves the service disabled/stopped and preserves existing journals.

The Step 4 office path is separate from the Compute Identity runner. `lxdOfficeGuestPlan`
constructs a full VM with a pinned local image, explicit root disk, controlled NIC
and persistent noncanonical workbench. It accepts no inherited profiles, runner
identity disk, provider credential options or canonical Company File mount.
`inspectLxdOfficeGuestBoot` checks exact local/expanded devices and configuration,
the image fingerprint and two reads of the actual guest boot ID. It performs no
creation or activation. The signed image, NAS mount identity, adoption and cloud
startup/activation protocol remain required.

`LxdUnixClient.readInstanceFile` implements the bounded file-read capability
needed by that inspection and bootstrap readback. It uses the Unix socket,
preserves LXD owner/mode metadata, rejects directory/symlink responses, does not
follow redirects, and enforces a 64 KiB maximum plus a five-second total deadline.
The caller still verifies the content, root ownership, expected digest and current
physical/cloud binding; file metadata alone is not an attestation. This follows
the [LXD file API](https://raw.githubusercontent.com/canonical/lxd/main/doc/rest-api.yaml).

`LxdOfficeOperationJournal` persists physical operation dispatch, acceptance and
settlement as immutable, sequenced records under a private provider-owned local
directory. The atomic no-overwrite publication winner may submit; concurrent
providers and restarted processes resume the same command ID. The allocation,
start-intent ID and complete office binding cannot change within that directory.
Records contain no guest credentials. The directory needs a durable local
filesystem supporting hard links and directory fsync, and must be retained with
the allocation. Losing it is not permission to recreate the guest.

`LxdUnixClient.submitInstanceOperation` returns an accepted operation ID without
waiting for completion. `inspectInstanceOperation` verifies the ID, task class,
VM/project and status on a bounded read. The target can use the older resource
list or [LXD 6.9 entity metadata](https://raw.githubusercontent.com/canonical/lxd/lxd-6.9/shared/api/operation.go);
conflicting identities fail closed. Stops are graceful, and deletes do not force
running VMs off. The existing Compute Identity runner API retains its behavior.

A lost submission response remains unknown. A recorded operation that returns
404 also remains unknown. Neither elapsed time, absent VM reads nor an empty
operation list proves that an in-flight create cannot finish. The journal blocks
further commands until the recorded operation settles; unrecorded acceptance
requires a separately verified provider recovery procedure, not automatic retry.
Terminal operation success still requires physical postcondition checks. This
layer does not reserve or release capacity, authorize starts, adopt storage,
activate the office or admit any native/member transport. Those lifecycle steps
must compose it with current control-plane authority and physical readiness.

`scripts/test-office-provider-journal-linux.mjs` bundles a disposable Linux proof
and requires an existing image selected by `QORPERA_OFFICE_TEST_IMAGE`. It runs
unprivileged with no network or capabilities, kills real child provider processes
at the submission/accepted-operation boundaries, and resumes against a local
Unix HTTP fixture. This proves process-crash journal recovery; it does not prove
an actual LXD guest, NAS adoption or power-loss durability of the deployed disk.

`LxdOfficeStartControl` connects a provider-resolved binding to durable cloud
startup demand. Open the immutable operation journal first, then reserve with
the same intent/allocation. The reservation pins image/bootstrap and a canonical
digest of every provider setting. An explicit capacity refusal permits no
physical effect. A lost response permits reconciliation with the original
binding only. Before each preparation, `check()` obtains fresh authority and
returns a cancellation signal whose five-second window includes registry
latency. Preserve the journal and allocation after timeout or revocation; neither
is deletion proof. The registry port is compatible with the headless runtime's
bounded HTTPS office registry transport.

`node scripts/test-runtime-office-start.mjs` runs the concrete control adapter
against a disposable network-isolated PostgreSQL database. It also races member
and native receipt deliveries, conflicting provider reservations, and preparation
blocked behind cancellation. VM configuration digests are synthetic. This does
not compose physical creation, image/NAS acceptance, adoption, activation or
cleanup; those remain required before the provider can run an office.

Office bindings now use `qorpera.lxd-office-guest/v2`. `providerId` and
`providerPolicySha256` participate in the instance digest, complete binding
digest, local journal and expected LXD metadata. A v1 journal is never upgraded
by inventing a provider identity. Infrastructure enrollment binds one provider
ID/policy to an office generation before allocation; it cannot adopt an already
allocated generation, change host/policy, or reassign ownership after a timeout.
The enrolled provider ID is protected infrastructure configuration, not a
measurement of the physical host. The preparation path must still verify the
local daemon/host against that policy before any physical effect.

`LxdOfficeProviderControl` reads one configured assignment through the service-only
provider status RPC. It validates exact scope/generation/provider/policy and
image/bootstrap pins. Discovery returns no provider paths, credentials, scripts
or startup permission. An explicit preparation-disable keeps retained demand
and allocation metadata readable for reconciliation, while fresh preparation
checks fail. It is not office shutdown or physical drain. The ordinary runtime
registry cannot enroll or reassign a provider; enrollment is a separate
infrastructure operation. The provider loop, storage adoption and activation
implementation remain required.

`LxdOfficePhysicalGate.open()` loads bounded root-owned policy and existing image
provenance files from protected local paths. It verifies a separate office image
envelope against the enrolled policy's Ed25519 public key and complete statement
digest. That statement binds the VM fingerprint, architecture, image size,
bootstrap, guest package, clean source and retained acceptance evidence. This
verifier has no signing or publication operation. Tests use ephemeral keys over
synthetic records only; no office candidate is signed by those tests.

The canonical `qorpera.lxd-office-physical-policy/v2` digest is the enrolled
`providerPolicySha256`. It includes the exact office scope/generation and guest
plan, host machine-ID digest, Unix socket path/group, daemon certificate/version/
name/architecture, image evidence and storage backing. A newly allocated binding
must retain that digest; a changed configuration requires explicit infrastructure
and generation handling, not local reenrollment or automatic journal conversion.
The v2 policy additionally pins the normalized project, effective network and
global storage-pool records, including their complete configuration maps. Prior
v1 policies cannot omit those checks. Usage lists and descriptions do not affect
the digests; changed resource configuration does. The supported network is a
created managed bridge with IPv4 NAT, IPv6 disabled and no external interface
or mutable ACL reference. Pools must be created with a local supported driver.
These checks use LXD's [project](https://raw.githubusercontent.com/canonical/lxd/lxd-6.9/shared/api/project.go),
[network](https://raw.githubusercontent.com/canonical/lxd/lxd-6.9/shared/api/network.go)
and [storage-pool](https://raw.githubusercontent.com/canonical/lxd/lxd-6.9/shared/api/storage_pool.go)
records. They pin configuration, not physical firewall or network-isolation proof.

`check()` observes the unprivileged Linux provider in PID 1's mount namespace,
root-protected socket, local persistent journal and dedicated NAS workbench,
then checks the actual daemon and exact private VM image, followed by another
host observation. The LXD reads use the
[server](https://raw.githubusercontent.com/canonical/lxd/lxd-6.9/shared/api/server.go)
and [image](https://raw.githubusercontent.com/canonical/lxd/lxd-6.9/shared/api/image.go)
records, reject mutable image aliases/profiles, and derive the reported
certificate digest from the returned PEM. Each read is bounded and read-only.

Storage inspection matches an open descriptor's `mnt_id` to
[Linux mountinfo](https://docs.kernel.org/filesystems/proc.html#proc-pid-mountinfo-information-about-mounts).
The supported workbench topology is a dedicated NFS v4.1/4.2 mount at the exact
guest source path, pinned export and server address, private uid/gid ownership,
`rw,nosuid,nodev`, TCP and hard retry behavior. Soft/softerr/softreval are refused;
the [NFS manual](https://man7.org/linux/man-pages/man5/nfs.5.html) documents why
hard operations may remain outstanding beyond a caller's timeout. The journal
requires a separate ext4/xfs/btrfs/zfs mount and private provider-owned directory.
Local fallback, nested/stacked mounts, symlinks and changed observations fail.
The gate does not create, mount, chmod or chown either directory.

The five-second result lifetime includes inspection time and must be combined
with fresh `LxdOfficeStartControl.check()` authority before each preparation
effect. Timed-out I/O occupies one process-wide slot until actual settlement,
including across replacement gate objects. A caller deadline is not filesystem
cancellation or permission to restart a provider while the old one still lives.
No successful check proves NAS liveness/durability, inventory/adoption, the LXD
daemon's mount propagation, physical network isolation,
guest readiness or cloud activation. Those checks and the journal-driven
execution/activation flow are still required. The creation reconciler below
composes this gate; a provider service entrypoint/package remains unfinished.

`scripts/test-office-physical-policy-linux.mjs` runs an offline disposable Linux
fixture, drops root after fixture setup, checks protected-file handling at uid
1000 and matches real descriptor/mount metadata. It verifies that local tmpfs
cannot satisfy the NAS policy. It does not create an LXD VM or contact a NAS.

`LxdOfficeCreationWorker` performs one bounded initial-creation reconciliation.
Its `open()` wires protected policy/image loading and the actual Unix LXD client
to the supplied headless registry transport. Cancelled/disabled demand and office
states outside provisioning/recovering cause no new preparation. The worker
validates physical policy, then persists an allocation-specific operation journal
before publishing the intent's immutable allocation and create-command identity.
Concurrent callers select the same intent record. A lost publication race may
leave an unallocated local journal; it cannot authorize a VM or consume cloud
capacity. No automatic deletion of those journals is implemented.

SQL reservation follows both local publications. Lost reservation responses
recover through discovery using the same allocation. Missing intent records after
reservation, missing operation journals after intent publication, mismatched
reservations, and changed policies fail closed. This also prevents recreating a
lost operation journal from an older `requested` discovery response. Each create
needs current cloud authority within the physical observation's remaining
lifetime. An existing unjournaled VM is never adopted as a successful create.

Accepted operations resume by exact ID; an unconfirmed submission is never
repeated. Successful creation requires a stopped VM with the exact image,
expanded devices and configuration, followed by another cloud check. The result
is `awaiting_adoption`, not active readiness. The worker never starts, stops or
deletes the VM, modifies the workbench, writes an adoption receipt or releases
capacity. It retains pending reconciliation after caller cancellation until the
underlying operation actually settles.

`node scripts/test-runtime-office-start.mjs --creation-worker` exercises this
worker against disposable PostgreSQL and a real Unix HTTP LXD fixture. It loses
a committed reservation response, replaces worker objects, observes one create
submission and checks a stopped fixture VM while SQL stays provisioning with
one charged allocation. Host/image/NAS authority is synthetic in that combined
test. The ordinary script mode still runs the original capacity/enrollment/
cancellation races. The remaining provider lifecycle must add actual adoption,
restricted guest readiness/startup, activation, continuation, cleanup and its
service entrypoint; no autonomous production provider loop is claimed here.

`LxdOfficeInventoryWorker` reads storage for an existing, completed initial
creation. It cannot allocate or dispatch a provider operation. Its actual Linux
scanner opens inodes with `O_PATH`, follows only verified regular-file descriptors,
streams directory enumeration and file hashing, and requires two identical full
inventories. Each entry includes its relative path, inode/device identity, owner,
mode, nanosecond change/modify timestamps, length and content hash. Entry count,
depth, individual/aggregate bytes, manifest size and elapsed work are bounded.
Cancellation keeps a process-wide scan slot occupied until outstanding I/O ends.
Nothing is truncated, silently skipped, copied, renamed or deleted.

Supported input is a private root with ordinary directories and singly linked
regular files owned by the pinned workbench uid/gid. Symlinks, hardlinks, special
files, unsafe names/modes, unreadable bytes and foreign ownership fail the entire
inventory. These cases require explicitly reviewed handling before adoption;
they are not classified as empty storage or silently discarded cache state.
Actual descriptor mount IDs must match the configured dedicated NAS mount.
Nested/stacked mounts and local fallback are refused.

The provider rechecks physical policy, host boot, exact stopped VM and current
cloud preparation authority around hashing. A journal containing any subsequent
start/stop/delete command, including an unknown outcome, cannot qualify as initial
creation. Successful observations are stored privately by content hash in the
existing local provider journal and checked on reuse. This evidence does not
prove that another NAS client could not write between observations, nor does it
acquire a writer fence or prove power-loss durability.

`readLxdOfficeStorageReview` reads an infrastructure-operator-installed document
from protected root-owned local storage. It binds the complete observation digest
(including allocation, policy and host boot), validated adoption-plan digest and
explicit writer-fence evidence. `initialize_empty` requires exactly the observed
empty root; zero-byte existing files or directories do not qualify. Existing state
requires `migrate_existing` and a separately validated plan with profile grants.
The loader never generates approval, verifies a live writer fence by itself,
performs migration or issues the completed guest receipt. The copy executor below
consumes this review; production live-guard composition and protected boot-receipt
installation remain to be connected.

`node scripts/test-office-storage-inventory-linux.mjs` verifies actual filesystem
and mount behavior on disposable tmpfs as uid 1000, including concurrent changes
and protected review loading. Review/operator authority in that probe is synthetic.
The worker tests separately exercise real local journals with synthetic cloud,
LXD, physical policy and scan ports. No NAS or real VM is modified by these tests.

`planLxdOfficeAdoption` uses the portable mapper in `@qorpera/contracts`; the
runtime retains its original adoption/layout exports. Provider preparation imports
no runtime implementation. An exhaustive operator mapping selects shared state,
legacy desktop identities and explicitly granted profiles, and records every
remaining source as quarantine. An explicit quarantine can exclude a sensitive
subtree from an otherwise selected tree. Unknown files and ambiguous mappings
fail. The plan creates four private roots under a new adoption-specific directory
and leaves all originals in place. Quarantined bytes are excluded from those
admitted roots. Browser grants never authorize copying provider identity paths.

`executeLxdOfficeAdoptionFiles` performs the actual Linux copy under a protected
review and immutable local journal binding. It requires a real process-owned
exclusive kernel flock on the existing private `adoption.lock`, matching real,
effective, saved and filesystem uid, zero permitted/effective capabilities and
no-new-privileges. The supervisor must provision that lock safely and exec the
worker under `flock --no-fork`; a stale file or another process's lock is not
authority. Missing lock/journal state must not be recreated behind a still-live
worker. A process-wide slot also remains occupied until cancelled I/O settles.

The executor verifies the approved source before the first effect and again on
recovery/completion. It writes bounded temporary files in an operation-specific
staging directory, verifies source hashes, fsyncs, and links complete files into
absent destinations without overwriting. Recovery validates completed files and
can discard only unpromoted temporary bytes in that journaled staging namespace;
it never deletes an original or overwrites a destination. A crash between link
and temporary unlink is recovered by matching the exact inode. Directory/file
permissions become private, preserving owner execution bits on files. Completion
requires empty staging, an exact separately inventoried destination tree, source
preservation and current authority, and writes immutable `copied` evidence.

`LxdOfficeAdoptionWorker.open()` connects that guard to actual Linux/LXD and
registry IO. At every checkpoint it checks the original creation identity and
journal, current physical policy and host boot, exact stopped VM and cloud
preparation authority for the full screen/profile mapping. The new service-only
`qorpera_check_runtime_office_adoption` RPC holds the provider/office fences while
checking cancellation, retained allocation, closed/drained surfaces, screen
generation, employed staff access, prepared profile, owner membership incarnation
and existing browser grant. A null profile mapping means quarantine; the provider
never creates consent, ownership or grants from directory names.

The infrastructure operator must separately fence all other NAS writers and
install a protected local `qorpera.lxd-office-storage-maintenance/v1` document.
It contains exactly `schema`, `state: "exclusive_writers_confirmed"`, `hostBootId`,
`providerBindingSha256`, `observationSha256` and `planSha256`. The review pins its
exact file bytes through `writerFence.evidenceSha256`. The worker re-reads it with
the root-owned, non-writable-parent protected loader at every checkpoint; removal
or a different boot/plan/hash refuses further copying. This is an explicit
operator maintenance handoff, not an automatically acquired NAS lock. Keep the
export fenced while the reviewed copy is running or awaiting admission. The
local flock only serializes this provider and cannot prove server durability.

The worker returns `copied` evidence. It cannot activate an office, admit native
or viewer clients, or produce a boot-bound guest receipt. The provider supervisor
entrypoint, guest preparation invocation, receipt installation and activation remain
separate lifecycle integration work. Constructor ports permit trusted tests;
production composition must use `open()` and actual protected files.

`node scripts/test-office-adoption-files-linux.mjs` exercises actual Linux files,
flock, protected review loading, source preservation, empty initialization,
profile quarantine, refusal paths and three real SIGKILL/restart windows. The
live provider/profile/export guard and operator approval are synthetic. The
disposable tmpfs proof does not mutate a NAS, boot a VM or install a guest receipt.

## Restricted first boot and guest preparation

`LxdOfficeBootWorker` consumes the existing creation identity, hashed inventory,
reviewed adoption plan, protected review/maintenance handoff and immutable copy
result. Under the existing kernel flock, it repeatedly checks the physical
provider, unchanged host boot, copied evidence and current SQL adoption authority.
It persists one first-boot identity before dispatch and permits only the initial
successful create followed by that exact start command. Later lifecycle commands,
missing acknowledged evidence and changed bindings require explicit recovery.
The provider supervisor must serialize all phases in its process and preserve the
same external writer handoff; this worker does not acquire a remote NAS lock.

Known pending start operations resume after process replacement. Unknown
submissions remain unknown even if a subsequent VM lookup reports running. A
successful start requires repeated exact VM configuration and guest boot readback
around renewed authority. The write-once boot observation and completion record
bind the same allocation/copy/start command. A different boot cannot replace a
retained observation. The result is `awaiting_preparation`; the worker never
pushes files, executes guest commands, installs credentials or releases capacity.
The pinned image must keep ordinary services closed without provider-installed
configuration and credentials.

`createLxdOfficeGuestPreparationRequest` translates matching retained copy inputs
into the shared portable manifest. The separate guest preparation entrypoint
verifies actual boot, Linux privileges/limits, persistent mount and copied tree
without opening ordinary office authority. Its package and isolated unit are
described in `deploy/lxd-company-computer-guest/README.md`. This pure translator
does not load protected evidence, prove daemon NAS propagation or validate a
completed systemd invocation.

`node scripts/test-runtime-office-start.mjs --boot-worker` combines actual SQL,
the production Unix HTTP client, real local journals, creation and first-boot
workers. It resumes one accepted start, preserves one charged allocation with the
office still provisioning, and rejects fresh preparation after provider disable.
The VM, physical NAS gate, copied bytes and operator/kernel-lock inputs in this
particular test are synthetic. Separate Linux probes exercise the real copied
tree verifier and operation-journal SIGKILL recovery; these are not deployed VM
or systemd lifecycle acceptance.

`LxdOfficePreparationWorker` now composes the retained first-boot verifier,
bounded staging, durable preparation command and protected guest completion.
It requires acknowledged boot evidence before any work, derives the request
from the reviewed copy, and fixes the image's virtiofs tag and preparation-unit
limits. Fresh kernel, physical, SQL adoption, writer-handoff, copy and guest-boot
checks precede staging, dispatch and completed evidence. Cancellation retains
underlying boot-verifier IO until settlement before admitting another attempt.
Known operations resume across provider replacement without restaging or a new
command. An unknown dispatch cannot use a guest report to bypass lost acceptance.
Matching root-owned completion and report bytes are read twice, bound to the
retained command/request/invocation and published as private durable observations.
The helper also atomically installs `/etc/qorpera-office/adoption.json` as
root:root `0444`, and its v2 completion binds that receipt's digest. The worker
independently derives the copied-state receipt and requires exact protected
readback twice before retaining its path/hash with the completion. Old v1
completions are refused. The result is `awaiting_activation`. Missing acknowledged evidence or command
journals cannot be reconstructed after dispatch.

The configuration worker below installs and verifies protected service files.
Matching cloud activation remains required. A report file by itself is never authority.
The current LXD readback
API remains capped at 64 KiB, while the new separate `LxdOfficePreparationClient`
supports request staging/readback up to 16 MiB. It derives only
`/run/qorpera-office-preparation/incoming-<requestSha256>.json`, requires a
root-owned protected inbox supplied by the pinned image, uploads private `0400`
bytes and checks exact length/hash/uid/gid/mode on readback. Upload preserves a
copy of the caller's buffer before awaiting IO and accepts only a synchronous
success reply. Both directions have five-second deadlines, reject redirects and
conceal raw daemon/file contents in failures. These staging calls must run under
current provider authority for the exact boot. The preparation worker invokes
the pinned root helper to atomically install the active request and inspect/start
the fixed preparation unit.
Ordinary office preflight continues to require active SQL state and a protected
matching receipt. The supervisor/entrypoint and activation continuation remain
unfinished; no production startup is enabled by these components.

`LxdOfficePreparationJournal` retains one command per allocation, bound to the
complete provider binding, initial boot observation, guest boot ID and request
digest. Initial creation is explicit and exclusive; reopening a missing or
damaged journal never recreates it. A fsynced dispatch precedes the only POST,
and the accepted operation ID is retained before observation, including shutdown
after an accepted reply. Unknown submissions cannot be retried; a missing known
operation remains unconfirmed. Failed and completed commands are retained and
cannot become another preparation attempt. The supervisor must serialize phases
under the existing kernel lifecycle lock and recheck current SQL/physical/copy
authority before using this component.

The separate `submitOfficePreparation` method executes only the pinned-image
`/opt/qorpera-office/qorpera-company-computer-preparation-control.mjs` helper,
through a fixed absolute Node command with a cleared environment and three
validated identifiers. It accepts no caller-selected executable, environment,
shell, file path or credential. It does not wait, open websockets or record guest
stdout/stderr in LXD logs. `inspectOfficePreparation` checks the exact operation
and instance/project, then requires a valid zero guest exit in addition to task
success. This matches [LXD 6.9 exec result handling](https://github.com/canonical/lxd/blob/lxd-6.9/lxd/instance_exec.go),
which records the process exit separately. Submission and observation each have
a five-second deadline. The runtime packages the
root helper with protected atomic request/claim/completion installation and a
fixed systemctl adapter; actual systemd execution still needs acceptance. A
recorded successful exec is historical command evidence and never
substitutes for fresh boot/report checks, office activation or capacity release.

`node scripts/test-runtime-office-start.mjs --preparation-worker` additionally
exercises the three concrete workers against disposable PostgreSQL and real Unix
HTTP: one create, one first boot, one preparation upload/exec, pending-operation
recovery, unchanged replay and refusal after provider disable. Guest files,
systemd, NAS/copy, kernel ownership and the physical VM remain synthetic in this
test. Actual Linux protected-file/kernel probes cover the helper separately;
actual systemd lifecycle and deployed VM/NAS acceptance remain outstanding.

## Protected service configuration

`LxdOfficeConfigurationWorker` requires acknowledged preparation before any
work. Its provider-only request adds `serviceBootstrapPath`, a root-owned local
document with schema `qorpera.lxd-office-service-bootstrap/v1`. The document
binds `providerBindingSha256` for the exact allocation, canonical HTTPS registry
and object-gateway origins, distinct native/viewer IP listeners, viewer origins,
and five credential references (`registry`, `native`, `objects`, `tlsCert`,
`tlsKey`). Each reference contains only an absolute local path, length and hash.
The signed image's `bootstrapSha256` retains its original image meaning.

Credential files must be root-owned, singly linked, on protected local paths,
and `0400` or `0440` with the provider's dedicated primary group. World-readable,
provider-owned, writable, linked, redirected and NAS-backed source files are
refused. Tokens must be distinct, and the TLS certificate/key must match.
The service configuration derives scope, generation, adopted paths, mounts,
limits and boot attestation from the verified preparation. The worker retains
the exact bootstrap document hash, payload hash and preparation observation;
credential values are excluded from local journals and diagnostics.

`LxdOfficeConfigurationClient` stages at most 192 KiB to the fixed root-only
`configuration-incoming-<sha256>.json` path and invokes only the packaged
configuration control helper. Five-second transport bounds, no guest output
recording and zero-exit validation also apply. Preparation and configuration
journals share their durable implementation with distinct schemas/directories;
existing preparation journal bytes remain compatible. Known operations resume,
uncertain submissions remain unknown, and missing acknowledged identities are
refused. All lifecycle phases require the supervisor's process-owned kernel lock.

The worker rechecks preparation, physical/cloud authority, boot and protected
inputs before effects. It independently verifies root ownership, mode, size and
hash for all six installed files twice, plus the bound helper completion. Only
then does it retain configuration evidence for activation. Cancellation keeps
pending nested IO occupied until settlement. It starts no ordinary service and
does not activate SQL admission or release capacity.

`node scripts/test-runtime-office-start.mjs --configuration-worker` exercises
creation, first boot, preparation and configuration through disposable SQL and
actual Unix HTTP, including provider replacement, one dispatch per phase and
refusal after provider disable. The SQL test uses synthetic physical/helper
ports. Separate offline Linux probes exercise real credential custody and real
SIGKILL recovery; actual systemd/VM/NAS lifecycle acceptance remains outstanding.
