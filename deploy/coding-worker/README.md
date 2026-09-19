# Isolated coding workers

This is the Linux LXD/Codex source candidate for runtime-contract Order 9. Order 9 remains open until installed acceptance and the selected additional capabilities are complete. The migrations leave coding execution disabled until an operator configures its executor, repository grants, orchestrator binding, and VM policy.

## Execution path

The parent dispatch tool creates a durable worker, request and todo handle. The executor claims one request with a renewable SQL lease, materializes the coding wake through canonical admission, reserves company and node capacity, and reconciles a retained repository VM. The repository VM has a fixed worker branch, two exact dedicated NAS mounts, no identity volume, and no GitHub, provider or cloud-control credential.

The native model runs through the existing provider on its separate identity allocation. Its four tools start/read/cancel repository commands and submit a final commit. Commands execute as the coding uid in a bounded systemd cgroup. A root-owned guest lease, tied to the boot and Linux uptime, expires independently of the executor's network connection. A reviewed timer stops the entire command slice on expiry. A receipt's hash binds the exact command, timeout, worker, VM, request and turn.

After native completion, the executor verifies command quiescence, exports the exact commit as a bundle, validates it in a fresh constrained Git broker, pushes only the fixed worker branch, and creates or verifies the same draft PR. It physically stops the VM before recording successful completion. The disk and canonical capacity custody remain retained. Follow-up reuses the worker, allocation, repository and branch; a new native runner does not replace that repository allocation.

An independent completion listener consumes the SQL outbox and delivers one causal wake to the parent. The worker has no human messaging tool. The parent can continue other work while coding runs. Neither service depends on a desktop client remaining online.

Unknown create, command, push, PR or dispatch outcomes retain intent and require observation/reconciliation. Process restart is not permission to replay an effect. Expired or revoked request authority does not grant resume; cleanup has a separate stop-only authorization. A failed or uncertain run must remain visibly unsuccessful.

## Package and configure

Build the three reviewable artifacts on an allocated Linux runtime node from a checkout whose `npm run check` passes:

```sh
node scripts/package-coding-guest.mjs --out /task-owned/new-guest-package
node scripts/package-coding-executor.mjs --out /task-owned/new-executor-package
node scripts/package-coding-listener.mjs --out /task-owned/new-listener-package
```

The scripts package files and checksums; they do not install or activate services. The executor and listener packages also pin the generated runtime bundle. The guest package includes storage initialization, command, Git and watchdog entrypoints. Install those artifacts and the supplied watchdog service, timer and slice into a dedicated coding image, with the ownership, workspace and utility requirements in `command-guest-installation.json` and `COMMAND-GUEST.md`. Enable the timer in the image. Use a separate non-root coding account with no privileged groups and a NAS-backed `/workspace/repository`, `/workspace/home` and `/workspace/cache`. Configure its Git author identity as a service identity.

Before enabling work, independently verify image/bootstrap provenance, isolated LXD project/network policy, blocked metadata/control-plane/office-network access, storage and genuine reserved node capacity. Pin the resulting image fingerprint, bootstrap digest and provider policy. A pinned network name is not by itself evidence of network isolation. Disposable unsigned candidate tests are permitted by the runtime contract; production activation retains the provenance gates.

Install `qorpera-coding-executor.service` with its persistent dedicated account and private NAS control directory. The service uses the local LXD socket, protected machine identity, a loopback HTTP backend, and a separately configured HTTPS reverse proxy. Its reviewed JSON configuration has this shape (substitute measured deployment values):

```json
{
  "schema": "qorpera.coding-executor-service/v2",
  "owner": "coding-node-02",
  "supabaseUrl": "https://PROJECT.supabase.co",
  "supabasePublishableKey": "PUBLIC_KEY",
  "orchestratorId": "ADMITTED_ORCHESTRATOR_UUID",
  "providerUrl": "https://NATIVE_PROVIDER_ORIGIN",
  "providerAdapterId": "native-node",
  "commandPort": 8789,
  "storagePolicy": {
    "schema": "qorpera.coding-nas-policy/v1",
    "mountPoint": "/srv/qorpera-coding",
    "rootPath": "/srv/qorpera-coding/executor",
    "source": "NAS_IPV4:/DEDICATED_CODING_EXPORT",
    "serverAddress": "NAS_IPV4"
  },
  "vmPolicy": {
    "providerId": "native-node",
    "providerPolicySha256": "MEASURED_SHA256",
    "project": "coding",
    "imageFingerprint": "MEASURED_SHA256",
    "bootstrapSha256": "MEASURED_SHA256",
    "storagePool": "coding-disks",
    "network": "coding-net",
    "cpus": 2,
    "memoryBytes": 4294967296,
    "rootDiskBytes": 68719476736
  },
  "guest": {
    "uid": 1000,
    "gid": 1000,
    "workspacePath": "/workspace/repository",
    "homePath": "/workspace/home",
    "cachePath": "/workspace/cache",
    "outputRoot": "/var/lib/qorpera-coding/logs",
    "resourceProfile": {"maxTimeoutMs": 1800000, "memoryBytes": 2147483648, "tasksMax": 256, "cpuQuotaPercent": 200, "maxLogBytes": 67108864},
    "storageHelperSha256": "PACKAGE_SHA256",
    "commandHelperSha256": "PACKAGE_SHA256",
    "gitHelperSha256": "PACKAGE_SHA256",
    "watchdogHelperSha256": "PACKAGE_SHA256"
  },
  "repositories": [{
    "repository": {"host": "github.com", "owner": "OWNER", "name": "REPO", "baseBranch": "main"},
    "credential": "qorpera-coding-repository-example"
  }]
}
```

All privileged credentials use systemd `LoadCredential`: registry service key, orchestrator control token, provider transport token, distinct coding-command transport token, and one explicitly scoped repository credential for each configured repository. Add the repository `LoadCredential` entries to the reviewed service unit. Provision repository-limited contents and pull-request permissions; never put a credential into configuration JSON, a model prompt or the repository VM. Configuration allowlisting does not substitute for current SQL repository authority.

On the **native provider** service, select `QORPERA_NATIVE_RUNTIME=company-path-v1`, set `QORPERA_CODING_COMMAND_URL` to the executor's HTTPS origin, and provision the same distinct `qorpera-coding-command` systemd credential. The fenced Codex binary, existing native isolation and identity recovery configuration remain required. Rebuild/provision the native image through its existing reviewed deployment process; do not attach an existing identity volume to a repository VM.

Install the independent listener unit with its `owner`/`supabaseUrl` configuration and registry credential. Configure SQL executor ownership, repository grants, native orchestrator binding, exact VM policy, and dedicated NAS source/machine placement through the migration-defined administrative RPCs. Apply bundle activation only with the matching installed artifacts and completed credential-generation adoption procedure.

## Acceptance still required before declaring Order 9 complete

Exercise the installed path through a real parent dispatch: edit and test a disposable repository, publish a real draft PR, receive the completion wake with clients offline, and follow up on the same worker/VM/repository/branch/PR. Record actual provider, LXD, systemd, storage and network evidence. Include cancellation, lease/network loss, sponsor/repository revocation, process replacement and unknown-effect reconciliation. Verify the guest watchdog stops actual processes and that repository code cannot obtain host/provider/GitHub credentials.

Component tests use real Linux processes, Git and PostgreSQL where stated, and simulated LXD/provider/systemd ports where stated. Those passing tests do not close the installed end-to-end gate. PostgreSQL component proof on 18.6 must not be presented as parity with an intended 17.6 deployment.

## NAS, retained credentials and deployment limits

Provision a dedicated hard NFSv4.1/4.2 TCP export with `nosuid,nodev`, pinned source address, byte/inode quotas and private executor-owned `rootPath`0700. The existing company object store and office exports are not coding allocations. Install a service drop-in with `RequiresMountsFor` and `ReadWritePaths` for the measured NAS path. The underlying unmounted directory must be root-owned and contain no writable fallback workspace. The control journal is `rootPath/control`; per-worker data and guest custody use deterministic company/environment/worker subdirectories. Local VM root is only the reproducible OS/toolchain. Never silently copy work to local disk.

The two exposed roots are executor-owned0755 with immutable0444 binding markers. The coding UID must differ from that owner. The trusted guest initializer creates exact coding-owned repository/home/cache/log directories and root-owned custody children only through verified virtiofs descriptors. The export must support those ownership operations, or an operator must preprovision the exact directories; the helper does not weaken ownership when root squashing prevents initialization. A 9p fallback is refused. The temporary watchdog lease alone lives under `/run/qorpera-coding`, so a hard-NFS stall cannot prevent local expiry.

NAS placement and writer generation1 are pinned in SQL and on disk. This implementation has no automatic cross-node takeover, marker overwrite or cold-replacement protocol. Queue expiry does not fence storage. Restoring snapshots or introducing a successor writer requires a separate physical-fencing and recovery procedure. Backup, retention and volume-quota proof remain rollout gates.

Native provider credential generations retain encrypted refreshed Codex state after the official client settles. See [credential ownership](../first-node/native-codex/credential-ownership.md) for rollout and recovery. All relevant identity hosts must use the managed generation path; an older host must never consume a stale enrollment capsule. One managed process owns each login at a time. This is not proof of simultaneous same-login runs or of Claude/Gemini adapters.

Migration `20260919094500_coding_emergency_stop.sql` provides independent SQL stop custody when the normal NAS journal is unavailable. It verifies the stored VM binding, permanently fences ordinary execution and dispatches at most one tracked graceful stop. An unknown dispatch is never retried. A later authorized cancellation can reconcile the original operation. A stopped observation does not establish storage-writer exclusion, release capacity or permit resume; failed or uncertain stop remains recovery-required. Operators must also settle previously issued physical operations before recovery. This is not an automatic fencing or replacement service.

The Git broker requires `/usr/bin/bwrap` (no unsafe fallback), user namespaces, seccomp and the reviewed host egress policy. Untrusted local Git parsing has no network or credentials. HTTPS stages still need enforcement against internal TCP destinations, and Git scratch needs an aggregate NAS quota. Normal upstream base advancement is accepted without changing the pinned worker ancestry. The current complete-bundle transport remains bounded at64MiB; large-repository streaming is a separate open gate.

A full Linux LXD VM is the implemented compute backend. Desktop/browser tooling and true Firecracker microVMs are not advertised by this image. User-level dependency installation can use NAS-backed home/cache/workspace; privileged OS installation requires a reviewed image update. Windows/macOS and additional subscription clients require their own accepted adapters.
