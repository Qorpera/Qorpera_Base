# Qorpera Runner Orchestrator

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

`QORPERA_RUNNER_ORCHESTRATOR_POLL_MS` optionally controls the durable
reconciliation interval. `QORPERA_RUNNER_ORCHESTRATOR_CONCURRENCY` controls the
bounded concurrent dispatcher (default 8, maximum 64). The service deliberately
has no desktop fallback.

The bootstrap orchestrator token is used only when the control-state file does
not exist. The service persists a pending replacement before rotation, sends
only its SHA-256 hash to the control plane, and can replay a lost rotation
response under the already-installed replacement. Protect and durably mount the
state file for the orchestrator service account; losing both it and the current
server authority requires an operator re-enrollment. This token authorizes only
orchestration control and is not a provider or member subscription credential.
