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

The process provider additionally requires:

- `QORPERA_SUPABASE_SERVICE_KEY`
- `QORPERA_EPHEMERAL_RUNNER_MODULE`
- `QORPERA_NATIVE_PROVIDER_MODULE`
- `QORPERA_NATIVE_PROVIDER_MASTER_KEY_FILE` (an infrastructure-mounted 32-byte base64url capsule key; only the native host reads it)
- `QORPERA_NATIVE_PROVIDER_EXECUTION_BOUNDARY`
- `QORPERA_RUNNER_PROVIDER_STATE_ROOT`
- `QORPERA_RUNNER_PROVIDER_TEMPORARY_ROOT`
- `QORPERA_EPHEMERAL_RUNNER_IMAGE`
- `QORPERA_EPHEMERAL_RUNNER_PODMAN`
- `QORPERA_EPHEMERAL_RUNNER_ENTRYPOINT`

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
