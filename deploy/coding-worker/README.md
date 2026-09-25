# Coding sessions: the executor

This is the Linux LXD/Codex executor for runtime-contract Order 9, on the coding-session kernel of Step 9 part 1 (migration `20260922210000`, sessions as sponsored workers) and part 3 (`20260922220000`, the executor's SQL). Order 9 remains open until installed acceptance is complete. The migrations leave coding execution disabled until an operator configures an executor (`qorpera_configure_coding_executor`), its repository grants, its VM policy and its NAS policy.

## Execution path

An agent dispatches a coding session through `manage_worker` (species `coding`); the session is owned and sponsored by one member, who may have any number of sessions. The executor claims session turns with renewable SQL leases (`qorpera_claim_coding_session`) and runs many at once. Each turn runs on its member's coding machine: one LXD VM per company, environment and member (bundle v101), planned in SQL from the executor's VM policy (`qorpera_plan_coding_machine`) and started, or woken, on reserved company and node capacity. The executor hot-plugs the session's two exact NAS folders into it, installs the session's configuration and user, and seeds a credential-free checkout at a pinned base, once per session. The machine has no identity volume and no GitHub, provider or cloud-control credential; each session has its fixed branch (`qorpera/coding/<worker>`). The executor then admits the model turn through the wake bus under the owner's own sponsor (`qorpera_begin_coding_turn`). Model turns never run on the coding machine; the harness runs on the member's execution host and reaches the machine only through the command gateway. A turn that cannot have its machine yet (a full node, its machine being removed, the session still on an earlier machine that is awake) goes back to the queue (`qorpera_defer_coding_session`) and is claimed again later; nothing counts or caps sessions.

The native harness runs the turn on the identity host like any other run, in the coding composition: three tools start/read/cancel repository commands through this service's command gateway, `coding_finish` submits a commit, `coding_ask` submits a question for the owner. Commands execute as the session's own uid in the session's bounded systemd slice. A root-owned guest lease, tied to the boot and Linux uptime, expires independently of the executor's network connection; a reviewed timer stops the entire command slice on expiry. A receipt's hash binds the exact command, timeout, worker, VM, turn id and sequence. Every command is authorized in SQL against the turn (`qorpera_authorize_coding_command`) before it starts.

The harness's submission is durable in SQL (`qorpera_submit_coding_turn`); the executor waits on `qorpera_describe_coding_turn` for the run to end and acts on the submission, never on prose. A commit is exported as a bundle, validated in a fresh constrained Git broker, pushed only to the fixed session branch, and published as the same draft PR. The session is detached before it is completed (`qorpera_complete_coding_turn`: succeeded with the PR, blocked with the question and its choices, or failed): its commands are stopped and seen stopped, the guest is synced, its boot-local state and user are removed, and its NAS folders are unplugged. The machine keeps running for the member's other sessions. The owner's answer or a follow-up starts the next turn on the same worker, NAS folders, repository and branch, on the member's current machine. Every turn is a row of its own (`qorpera_coding_session_turns`, 20260925113000): what started it (the dispatch, the agent's follow-up or the owner's answer), the harness's submission, which belongs to that turn's sequence only, and how it ended. The next turn reads them through its run authority (`qorpera_read_coding_turn_context`) and the native runtime composes them into its context: the exact question and choices a reply answers, and the session's earlier turns (the newest that fit, the rest counted). A new turn never inherits an earlier submission; when an executor is lost after the harness submitted, the lease expiry settles that turn as failed, keeps the submission in it and names the unanswered question or the unpublished commit, and the owner's retry runs clean. The provider thread itself is not resumed: continuity is the composed record, not provider-held state.

## Member machines: sleep, wake and removal

Every 30 s the executor asks SQL for its machines on this node (`qorpera_list_coding_machines`) and acts on the ones due:

- **Sleep.** A machine with no session turn on it for `machine_sleep_after_seconds` (default 600) is put to sleep: every session's commands are stopped and the guest synced, the machine is powered off under its journal, its session folders are unplugged while it is off, and its node demand is suspended (`qorpera_suspend_coding_machine`). Asleep, it holds no node capacity; its root disk stays. The next turn wakes it (re-reserving capacity, or waiting in the queue on a full node).
- **Removal.** A machine asleep for `machine_remove_after_seconds` (default 86400), or planned from an older VM policy, is deleted under a journaled LXD delete; only that delete plus LXD's absence of the instance releases its allocation (`qorpera_release_coding_machine`). A machine never given node capacity, or already released elsewhere, is closed without touching LXD. The member's next turn gets a new machine; the NAS folders are never removed by this.
- **Kept per-session VMs** from before bundle v101 are retired the same way (stopped, deleted, released) once their session has no turn; only the VMs go, their NAS folders stay. A session whose previous machine is still awake waits until it sleeps (`PREVIOUS_MACHINE_AWAKE`).

SQL re-checks custody for every effect, so a turn that takes the machine in the meantime only makes the step "not now". A failed step is written to the machine (`last_error`, `qorpera_record_coding_machine_error`), logged as `coding-machine-error`, and retried at the next pass; a later success clears it. A failed release is its own step (`release`): after a delete the machine is gone but its capacity is not yet returned; for a machine that never had one, or was released elsewhere, only the record is not yet closed. Housekeeping runs beside claiming, so a long pass never holds up a turn. Nothing is hidden or silently dropped. Both delays are per-environment configuration (`qorpera_configure_coding_machine_lifecycle(environment, owner, sleepAfterSeconds, removeAfterSeconds)`, 60–86400 s and 300–31536000 s), not constants.

A stop first stops the command slices and syncs the guest (8 s), then powers the machine off within 30 s; a stop LXD reports failed, or no longer knows, is settled from the machine's own state and re-issued while it still runs, at most three times in a row. A delete is re-issued the same way only while the machine is there and stopped. A machine whose journal cannot settle is `recovery-required` for an operator.

The Order 5 completion path wakes the managing agent with the outcome; there is no separate listener. The thread shows the session from the kernel's own view and events. Neither the agent nor a member client needs to be online while the session runs.

Unknown create, command, push, PR or dispatch outcomes retain intent and require observation/reconciliation. Process restart is not permission to replay an effect. Expired or revoked request authority does not grant resume; cleanup has a separate stop-only authorization. A failed or uncertain run must remain visibly unsuccessful.

## Package and configure

Build the two reviewable artifacts on an allocated Linux runtime node from a checkout whose `npm run check` passes:

```sh
node scripts/package-coding-guest.mjs --out /task-owned/new-guest-package
node scripts/package-coding-executor.mjs --out /task-owned/new-executor-package
```

The scripts package files and checksums; they do not install or activate services. The executor package also pins the generated runtime bundle. The guest package includes storage initialization, command, Git and watchdog entrypoints. Install those artifacts and the supplied watchdog service, timer and slice into a dedicated coding image, with the ownership, workspace and utility requirements in `command-guest-installation.json` and `COMMAND-GUEST.md` (sessions on a member's machine: paths, slices, users). Enable the timer in the image. Mask the five apt self-update units (`apt-daily{,-upgrade}.{timer,service}`, `unattended-upgrades.service`) in the image build; the guest and the executor refuse an image where any is not a link to `/dev/null` (`RUNNER_IMAGE_SELF_UPDATE_ENABLED`, see `COMMAND-GUEST.md`). Keep the image's non-root coding account (uid and gid below 200000, no privileged groups): sessions whose NAS volume predates member machines run as it. Every other session runs as its own uid/gid in 200000–524287, registered per boot as a `/run/userdb` record, so the image needs nss-systemd for passwd and group (the Ubuntu default). Each session's NAS-backed `/workspace/<worker>/repository`, `home` and `cache` are attached per turn. Configure Git's author identity as a service identity for every user (system gitconfig).

Before enabling work, independently verify image/bootstrap provenance, isolated LXD project/network policy, blocked metadata/control-plane/office-network access, storage and genuine reserved node capacity. Pin the resulting image fingerprint, bootstrap digest and provider policy. A pinned network name is not by itself evidence of network isolation. Disposable unsigned candidate tests are permitted by the runtime contract; production activation retains the provenance gates.

Install `qorpera-coding-executor.service` with its persistent dedicated account and private NAS control directory. The service uses the local LXD socket, protected machine identity, a loopback HTTP backend, and a separately configured HTTPS reverse proxy. `owner` must be the executor's owner in `qorpera_coding_executors` (with `harnesses` naming `codex`). Its reviewed JSON configuration has this shape (substitute measured deployment values):

```json
{
  "schema": "qorpera.coding-executor-service/v5",
  "owner": "coding-node-02",
  "supabaseUrl": "https://PROJECT.supabase.co",
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
    "cpus": 4,
    "memoryBytes": 8589934592,
    "rootDiskBytes": 68719476736
  },
  "guest": {
    "uid": 1000,
    "gid": 1000,
    "resourceProfile": {"maxTimeoutMs": 1800000, "memoryBytes": 2147483648, "tasksMax": 256, "cpuQuotaPercent": 200, "maxLogBytes": 67108864},
    "storageHelperSha256": "PACKAGE_SHA256",
    "commandHelperSha256": "PACKAGE_SHA256",
    "gitHelperSha256": "PACKAGE_SHA256",
    "watchdogHelperSha256": "PACKAGE_SHA256"
  },
  "broker": {
    "origin": "https://BROKER_PUBLIC_ORIGIN",
    "executorTokenCredential": "qorpera-coding-broker-executor"
  },
  "repositories": [{
    "repository": {"host": "github.com", "owner": "OWNER", "name": "REPO", "baseBranch": "main"}
  }]
}
```

`vmPolicy` sizes one member's machine, shared by that member's sessions; `guest.resourceProfile` bounds each command and must fit inside it. `guest.uid`/`gid` is the image's coding account (below 200000); session paths are not configured, they derive from the worker id. A config with the old `v4` schema is refused.

All privileged credentials use systemd `LoadCredential`: registry service key (`qorpera-coding-registry`), the distinct coding-command transport token (`qorpera-coding-command`) and the executor's own broker token (`qorpera-coding-broker-executor`, the name `broker.executorTokenCredential` gives). Never put a credential into configuration JSON, a model prompt or the repository VM. `repositories` is the executor's own allowlist; it does not substitute for current SQL repository authority.

## Repository access (bundle v88)

Members never hand-place repository tokens. A repository is reached through the GitHub connection of the session's company (Settings → Connections → Services, sealed in that company's secret broker, shared with every agent). For each step that touches the repository (resolving and seeding the base while the session is `preparing`, pushing the bundle and opening the draft PR while it is `publishing`) the executor posts `{workerId, leaseToken, executorOwner, repository}` to `POST <broker.origin>/v1/repository-credentials?company=<profileId>` with its own broker token. The public origin routes by `company=` to that company's broker, which asks the kernel (`qorpera_authorize_coding_repository_credential`). The kernel answers only when the session is leased to this executor owner with this lease token, the lease is live, the repository is the session's, the session's agent holds an enabled repository grant, and the company has an active GitHub connection sealed by that broker (the Services connection: company-owned, named `primary`; a secret card or any other company secret filed under github never serves) on which the agent holds a live grant; it audits every answer (`repository_credential_used`). The broker opens the envelope and returns `{schema, token}` with `Cache-Control: no-store`. The executor lends the token to the Git broker or GitHub API step and drops it; it is never cached, logged, stored or passed to the repository VM, and a refusal is never retried with another credential. Disconnecting the company's GitHub connection, revoking the agent's grants on it, withdrawing the repository grant or losing the lease stops the next step.

The executor's broker token is not the runtime token guests hold (`qorpera-cloud-secret-runtime`, which does not open this route): guests also hold the Supabase service-role key, can claim a coding session and so learn a lease token, so the lease token binds a request to a live session but does not authenticate the caller. The executor's token is 32 random bytes (base64url) that only the executor (`qorpera-coding-broker-executor`) and the brokers of companies running coding sessions (`qorpera-cloud-secret-coding-executor`, a drop-in) hold; it opens nothing but this route. The unit loads it unconditionally, so install the file before starting the executor. See the Step 7 connectors runbook for the broker side and the accepted risks (the OAuth token is account-wide; network Git egress is open). The origin must present a certificate Node trusts (a public CA, or `NODE_EXTRA_CA_CERTS` in a reviewed drop-in) and be reachable from the executor's node.

The OAuth connection carries the scopes the GitHub OAuth app grants (`repo`); what a session can push is bounded by that account's access and by the fixed session branch. A repository entry may still name a static `"credential": "qorpera-coding-repository-NAME"` (with its own `LoadCredential` in a reviewed drop-in). That is proof-only plumbing: it bypasses the company connection, so disconnecting the company's GitHub does not stop it. A configuration whose repositories all name static credentials may omit `broker`.

The identity guest receives the gateway from its host: on the **LXD provider** (and the shared execution service) set `QORPERA_CODING_COMMAND_URL` to the executor's HTTPS origin and `QORPERA_LXD_CODING_COMMAND_TOKEN_FILE` to a private file holding the same distinct transport token; the provider writes `QORPERA_CODING_COMMAND_URL` into the guest's native provider environment and the token into the `qorpera-coding-command` systemd credential (empty when no gateway is configured), and the guest bootstrap verifies both against its immutable bootstrap authority. The gateway certificate must chain to the cloud secret broker CA the guest already trusts (`NODE_EXTRA_CA_CERTS`). The native provider service selects the coding composition only when that URL is present. The fenced Codex binary, existing native isolation and identity recovery configuration remain required. Rebuild/provision the native image through its existing reviewed deployment process; do not attach an existing identity volume to a repository VM.

Configure SQL executor ownership (`qorpera_configure_coding_executor` with `harnesses`), repository grants (`qorpera_set_coding_repository_grant`), the exact VM policy (`qorpera_configure_coding_vm_policy`), the dedicated NAS source/machine placement (`qorpera_configure_coding_nas_policy`) and, if not the defaults, the machine sleep and removal delays (`qorpera_configure_coding_machine_lifecycle`) through the migration-defined administrative RPCs. A new VM policy supersedes every machine planned from the old one: each is removed when it is next idle and the member's next turn gets a machine from the new policy. Apply bundle activation only with the matching installed artifacts.

## Acceptance still required before declaring Order 9 complete

Exercise the installed path through a real agent dispatch: edit and test a disposable repository, publish a real draft PR, see the managing agent woken with the outcome and the thread element render the session with clients offline, answer a `coding_ask` question from the thread, and follow up on the same worker/VM/repository/branch/PR. Record actual provider, LXD, systemd, storage and network evidence. Include cancellation, lease/network loss, sponsor/repository revocation, process replacement and unknown-effect reconciliation. Verify the guest watchdog stops actual processes and that repository code cannot obtain host/provider/GitHub credentials.

Component tests use real Linux processes, Git and PostgreSQL where stated, and simulated LXD/provider/systemd ports where stated. Those passing tests do not close the installed end-to-end gate. PostgreSQL component proof on 18.6 must not be presented as parity with an intended 17.6 deployment.

## NAS, retained credentials and deployment limits

Provision a dedicated hard NFSv4.1/4.2 TCP export with `nosuid,nodev`, pinned source address, byte/inode quotas and private executor-owned `rootPath`0700. The existing company object store and office exports are not coding allocations. Install a service drop-in with `RequiresMountsFor` and `ReadWritePaths` for the measured NAS path. The underlying unmounted directory must be root-owned and contain no writable fallback workspace. The control journal is `rootPath/control`; per-worker data and guest custody use deterministic company/environment/worker subdirectories. Local VM root is only the reproducible OS/toolchain. Never silently copy work to local disk.

The two exposed roots are executor-owned0755 with immutable0444 binding markers. No session uid may equal that owner. The export must let root in the guest create and chown each session's directories to its uid (200000–524287) as well as to the image's coding uid: with root squashing, the operator grants those uids on the NAS before the cut (design proof 3). The trusted guest initializer creates exact coding-owned repository/home/cache directories and root-owned custody children (`logs`, `inbox`, `commands`, `git`) only through verified virtiofs descriptors. A volume initialized before bundle v93 has a coding-owned `logs` directory; the initializer refuses it (`CODING_GUEST_STORAGE_DIRECTORY_UNPROTECTED`) instead of repairing ownership, so such a worker needs a new volume or an operator `chown root:root` of that directory. Before that chown, check that `logs/` contains only root-owned per-command directories (UUID names, mode 0755, no symlinks or other entries); anything else means the volume was written by something other than the supervisor, and it should be replaced instead. The export must support those ownership operations, or an operator must preprovision the exact directories; the helper does not weaken ownership when root squashing prevents initialization. A 9p fallback is refused. Each session's temporary watchdog lease, configuration and user record live under `/run/qorpera-coding/<worker>` and `/run/userdb`, so a hard-NFS stall cannot prevent local expiry, and a machine that slept wakes with no session attached.

NAS placement and writer generation1 are pinned in SQL and on disk. This implementation has no automatic cross-node takeover, marker overwrite or cold-replacement protocol. Queue expiry does not fence storage. Restoring snapshots or introducing a successor writer requires a separate physical-fencing and recovery procedure. Backup, retention and volume-quota proof remain rollout gates.

Native provider credential generations retain encrypted refreshed Codex state after the official client settles. See [credential ownership](../first-node/native-codex/credential-ownership.md) for rollout and recovery. All relevant identity hosts must use the managed generation path; an older host must never consume a stale enrollment capsule. One managed process owns each login at a time. This is not proof of simultaneous same-login runs or of Claude/Gemini adapters.

The independent SQL emergency-stop custody of #140/#200 is not part of this executor yet: a stop that cannot be confirmed through the NAS journal returns `recovery-required` and an operator settles the machine. It returns in its own change on the session kernel.

The Git broker requires `/usr/bin/bwrap` (no unsafe fallback), user namespaces, seccomp and the reviewed host egress policy. Untrusted local Git parsing has no network or credentials. HTTPS stages still need enforcement against internal TCP destinations, and Git scratch needs an aggregate NAS quota. Normal upstream base advancement is accepted without changing the pinned worker ancestry. The current complete-bundle transport remains bounded at64MiB; large-repository streaming is a separate open gate.

A full Linux LXD VM per member is the implemented compute backend. Desktop/browser tooling and true Firecracker microVMs are not advertised by this image. User-level dependency installation can use NAS-backed home/cache/workspace; privileged OS installation requires a reviewed image update. Windows/macOS and additional subscription clients require their own accepted adapters.
