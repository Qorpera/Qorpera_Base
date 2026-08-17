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
`-- output/                  the only writable job mount
```

The host verifies every company manifest, file manifest, chunk, artifact hash, operation count, artifact ordinal, and declared byte total. Input and output budgets are checked before a completion result can be returned. Inputs are mounted read-only by the containment backend; `output/` is mounted as a job-private writable volume.

The sandbox receives a copied job payload, non-secret identifiers, an explicit environment allowlist, resource limits, and those mounts. It does not receive:

- Supabase account or refresh tokens.
- Runner activation, session, or lease tokens.
- Storage service credentials or object-bucket authority.
- Model-provider credentials.
- The host filesystem or Docker/VM control socket.

Model calls, Git fetches, package downloads, and object publication must go through host-side brokers. They are not reasons to put credentials or unrestricted networking inside the sandbox. The job-scoped object broker is implemented for exact substrate input and bounded direct artifact output; model and general network brokers are not.

## Required guarantees

A backend is eligible for untrusted work only when it declares and implements all of these properties:

- Rootless-container or microVM boundary.
- No host filesystem visibility.
- Read-only input and job-private output mounts.
- Deny-by-default network policy.
- Explicit environment allowlist.
- Unprivileged process with no host runtime socket.
- Kernel-enforced CPU, memory, process-count, and wall-time limits.
- Cancellation completes only after the container or VM has been destroyed.

The runner refuses weaker backends. The in-process backend used by tests requires a separate `allowTestBackend` flag and cannot be selected accidentally by normal execution.

## Rootless Podman backend

`RootlessPodmanSandboxBackend` is the first production containment implementation. It accepts only a digest-pinned image already present on the worker and invokes an absolute Podman binary path with no shell.

Every job receives:

- A new random container identity and `--pull=never` image resolution.
- `--network=none`, an empty inherited container environment, and disabled proxy propagation.
- A read-only image root with automatic image volumes disabled.
- One non-recursive, read-only input bind and one non-recursive, job-private output bind.
- A rootless `keep-id` user namespace, all capabilities removed, `no-new-privileges`, private IPC/PID/cgroup/UTS namespaces, and seccomp verified on the host.
- Kernel CPU, memory, swap, process-count, and wall-time bounds.
- Bounded stdout and stderr collection. The job request travels through stdin rather than the process list, and stdout must be one JSON object.
- `podman rm --force --time=0 --ignore` after success, failure, cancellation, or deadline expiry. Completion does not return until container destruction is confirmed.

The pinned image contract exposes `/qorpera/bin/run-job`. It reads one `qorpera.ephemeral-container-request/v1` object from stdin, reads immutable inputs under `/qorpera/input`, writes durable candidates only under `/qorpera/output`, and emits one bounded JSON result on stdout. The first bundled image implements only `sandbox_probe`: it verifies that the exact substrate manifest is mounted and produces a bounded `sandbox-proof.json`. It is an acceptance-test workload, not an agent runtime. The image, entrypoint, and worker daemon do not receive runner, Storage, account, or model-provider credentials.

`EphemeralCloudRunnerWorker` connects this backend to runner control and the job-scoped broker. It performs containment preflight before claiming, recovers one retained lease after restart, renews the lease and runner session serially while a container runs, publishes verified output, stages the completion result in the private authority store, and completes the job atomically. A staged completion always takes precedence over starting another container.

Output is scanned after containment stops. Links, aliases, special files, path escapes, excessive file counts, and excessive bytes are rejected. The host-side publisher rereads and rehashes each scanned file, uploads it through the current job lease, and registers a deterministic immutable artifact before the disposable directory is removed. The sandbox never performs that upload itself. The first broker contract accepts direct files up to 8 MiB; larger outputs require the later chunked-output extension.

## Production placement

For both ephemeral cloud runners and the first Qorpera Computer, use a dedicated Linux worker VM on a compute host and one rootless container per job. Do not run customer jobs directly on the NAS operating system. The worker VM should have no NAS administration access and no route to storage or management networks beyond narrowly scoped broker endpoints.

This separates two failure domains:

1. The container is the disposable job boundary.
2. The worker VM contains a container-runtime or kernel escape and can be destroyed or cordoned without exposing the NAS control plane.

MicroVMs are the stronger later boundary for hostile multi-tenant workloads. They cost more startup time and memory but reduce shared-kernel risk. The job contract does not change when the backend moves from a rootless container to a microVM.

## Remaining production work

1. Run the headless rootless-Podman workflow and then build, push, and sign the packaged `sandbox_probe` image in an OIDC-enabled registry environment. The standalone Node bundles, strict configuration, one-time systemd credential handoff, authority restoration, shutdown, image I/O contract, Linux containment harness, and Cosign build script are implemented. The hosted workflow exercises the real per-job Linux container boundary once these changes are landed; service-account lingering and host-reboot recovery still require a disposable Linux VM. No NAS process is involved.
2. Route model and approved network/tool operations through metered host brokers.
3. Extend the object broker for chunked outputs above 8 MiB and define explicit sibling-substrate merge/rebase operations.
4. Add abuse, escape, cancellation, host-reboot, disk-pressure, broker-revocation, image-supply-chain, and restore tests before registering physical hardware.
