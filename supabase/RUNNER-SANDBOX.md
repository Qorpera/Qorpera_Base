# Runner execution sandbox

The runner sandbox is a per-job containment boundary. A temporary directory alone is not a sandbox. Production execution must use a rootless container or microVM whose lifecycle is controlled by the runner daemon.

The NAS is not involved in this slice. The implementation builds and validates execution bundles, retains an explicitly test-only backend, and now includes a rootless Podman backend for dedicated Linux worker hosts. The production backend refuses non-Linux, rootful, remote, cgroups-v1, seccomp-disabled, or pre-Podman-5 hosts before materializing customer work.

## Job shape

Every claimed job already names one immutable company substrate version. The runner host resolves that version before starting a sandbox and creates a private disposable layout:

```text
job root
|-- input
|   |-- company/             verified immutable company-tree materialization
|   |-- substrate.json       exact snapshot, operation watermark, and artifact index identities
|   |-- operations.jsonl     ordered operations through that watermark
|   `-- artifacts/
|       |-- index.json       ordered immutable artifact metadata
|       `-- 000001/content   verified artifact bytes
|-- output/                  the only writable job mount
`-- broker/
    `-- model.sock           optional host-owned, job-private model adapter
```

The host verifies every company manifest, file manifest, chunk, artifact hash, operation count, artifact ordinal, and declared byte total. Input and output budgets are checked before a completion result can be returned. Inputs are mounted read-only by the containment backend; `output/` is a size-bounded job-private tmpfs whose contents are copied to the host only while the container boundary is still alive.

The sandbox receives a copied job payload, non-secret identifiers, an explicit environment allowlist, resource limits, and those mounts. It does not receive:

- Supabase account or refresh tokens.
- Runner activation, session, or lease tokens.
- Storage service credentials or object-bucket authority.
- Model-provider credentials.
- The host filesystem or Docker/VM control socket.

Model calls, Git fetches, package downloads, and object publication must go through host-side brokers. They are not reasons to put credentials or unrestricted networking inside the sandbox. The job-scoped object broker is implemented for exact substrate input and bounded direct artifact output. The model broker is exposed to an eligible job through a bounded Unix-domain socket; general network forwarding is not implemented.

## Required guarantees

A backend is eligible for untrusted work only when it declares and implements all of these properties:

- Rootless-container or microVM boundary.
- No host filesystem visibility.
- Read-only input and job-private output mounts.
- Deny-by-default network policy.
- Explicit environment allowlist.
- Unprivileged process with no host runtime socket.
- Kernel-enforced CPU, memory, process-count, output-filesystem, and wall-time limits.
- Cancellation completes only after the container or VM has been destroyed.

The runner refuses weaker backends. The in-process backend used by tests requires a separate `allowTestBackend` flag and cannot be selected accidentally by normal execution.

## Rootless Podman backend

`RootlessPodmanSandboxBackend` is the first production containment implementation. It accepts only a digest-pinned image already present on the worker and invokes an absolute Podman binary path with no shell.

Every job receives:

- A new random container identity and `--pull=never` image resolution.
- `--network=none`, an empty inherited container environment, and disabled proxy propagation.
- A read-only image root with automatic image volumes disabled.
- One non-recursive, read-only input bind and one empty, size-bounded tmpfs output mount. The host output directory is never mounted into the sandbox.
- When the job has model authority, one non-recursive, read-only broker-directory bind containing only `/qorpera/broker/model.sock`. The Linux Unix-domain socket is mode `0600`, accepts at most four simultaneous connections and 128 single-frame requests, and closes with the container boundary. Windows named pipes are rejected because this implementation does not establish an equivalent ACL boundary.
- A rootless `keep-id` user namespace, all capabilities removed, `no-new-privileges`, private IPC/PID/cgroup/UTS namespaces, and seccomp verified on the host.
- Kernel CPU, memory, swap, process-count, output-tmpfs, and conmon wall-time bounds.
- Bounded stdout and stderr collection. The job request travels through stdin rather than the process list, and the first stdout line must be one JSON object.
- `podman rm --force --time=0 --ignore` after success, failure, cancellation, or deadline expiry. Completion does not return until container destruction is confirmed. Startup also removes only exact `qorpera-job-<uuid>` containers and exact private workspace names left by an interrupted worker.

The pinned image contract exposes `/qorpera/bin/run-job`. It reads one `qorpera.ephemeral-container-request/v1` object from stdin, reads immutable inputs under `/qorpera/input`, writes durable candidates only under `/qorpera/output`, emits one bounded JSON result on stdout, and remains alive without further work until the trusted host copies output and destroys it. The host fails closed unless the container is still running before extraction. The first bundled image implements only `sandbox_probe`: it verifies that the exact substrate manifest is mounted and can issue one fake model request through the socket while direct networking remains disabled. It is an acceptance-test workload, not an agent runtime. The image and entrypoint do not receive runner, Storage, account, gateway, or model-provider credentials.

The socket protocol is newline-delimited `qorpera.runner-model-socket-request/v1` JSON with a 300 KiB request ceiling and 600 KiB response ceiling. It accepts only a request UUID, provider, model, JSON input, and output-token limit. The trusted worker passes the validated request to the current leased `CloudRunnerJobBroker`; generic failures cross back to the sandbox, while host and provider error details remain outside. The adapter cannot forward URLs or invoke arbitrary host functions.

`EphemeralCloudRunnerWorker` connects this backend to runner control and the job-scoped broker. It performs containment preflight before claiming, recovers one retained lease after restart, renews the lease and runner session serially while a container runs, publishes verified output, stages the completion result in the private authority store, and completes the job atomically. A staged completion always takes precedence over starting another container.

Output is copied from the live bounded tmpfs, the container is destroyed, and only then is the extracted host directory scanned. Links, aliases, special files, path escapes, excessive file counts, and excessive bytes are rejected. The host-side publisher rereads and rehashes each scanned file, uploads it through the current job lease, and registers a deterministic immutable artifact before the disposable directory is removed. The sandbox never performs that upload itself. The first broker contract accepts direct files up to 8 MiB; larger outputs require the later chunked-output extension.

## Production placement

For both ephemeral cloud runners and the first Qorpera Computer, use a dedicated Linux worker VM on a compute host and one rootless container per job. Do not run customer jobs directly on the NAS operating system. The worker VM should have no NAS administration access and no route to storage or management networks beyond narrowly scoped broker endpoints.

This separates two failure domains:

1. The container is the disposable job boundary.
2. The worker VM contains a container-runtime or kernel escape and can be destroyed or cordoned without exposing the NAS control plane.

MicroVMs are the stronger later boundary for hostile multi-tenant workloads. They cost more startup time and memory but reduce shared-kernel risk. The job contract does not change when the backend moves from a rootless container to a microVM.

## Remaining production work

1. Run the headless rootless-Podman workflow and then build, push, and sign the packaged `sandbox_probe` image in an OIDC-enabled registry environment. The standalone Node bundles, strict configuration, one-time systemd credential handoff, authority restoration, shutdown, image I/O contract, Linux containment harness, and Cosign build script are implemented. The hosted workflow exercises the real per-job Linux container boundary once these changes are landed; service-account lingering and host-reboot recovery still require a disposable Linux VM. No NAS process is involved.
2. Run the model-socket probe through the real Linux workflow to confirm that rootless Podman's read-only bind permits socket connection while `--network=none` remains enforced. The protocol, host lifecycle, worker wiring, portable client/server proof, command boundary, and Linux acceptance test are implemented locally. Then add separately approved named network/tool adapters; do not expose arbitrary URL forwarding. Successful sandbox resource observations and applied-limit reporting are implemented independently in `RUNNER-USAGE.md`.
3. Extend the object broker for chunked outputs above 8 MiB and define explicit sibling-substrate merge/rebase operations.
4. Add abuse, escape, cancellation, host-reboot, disk-pressure, broker-revocation, image-supply-chain, and restore tests before registering physical hardware.
