# Grok Bot computer audit for Company41 Step 2

**Audit date:** 2026-08-22

**Purpose:** identify reusable computer-lifecycle and user-experience patterns without importing Grok Bot's authority, credential, provider-routing, or shared-filesystem assumptions into Qorpera.

## Evidence boundary

Grok Bot's managed backend and computer runtime are proprietary. This audit therefore separates three evidence classes:

1. **Official:** current SpaceXAI/xAI Grok Bot documentation describing product behavior and security boundaries.
2. **Observed:** public runtime inspection of Cursor cloud-agent infrastructure and a recently indexed Grok Bot runtime inventory. These are useful implementation clues, not contractual facts about every Grok Bot deployment.
3. **Independent reconstruction:** the open `grokbot-shim` project at commit `f8c0b45724b964f9286c93d822962ce629011bae`, which extracts a user's installed Grok Bot host runtime and recreates a local Computer with a pinned container image. It demonstrates reachable interfaces and lifecycle shape; it is not xAI source code or a production security reference.

The previously public `groksense/grok-bot-runtime` repository was no longer cloneable during this audit. Only its indexed, redacted inventory summary was used, and no unavailable content is treated as authoritative.

## Sources

Official:

- [Grok Bot overview](https://docs.x.ai/grok-bot/overview)
- [Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)
- [Approvals, security, and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- [Teams and enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises)
- [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)
- [Frequently asked questions](https://docs.x.ai/grok-bot/faq)

Observed or independently reconstructed:

- [Cursor Cloud Agent architecture and internals](https://gist.github.com/mxschmitt/e83db32079f25c291853626d5aeb6cc5)
- [grokbot-shim](https://github.com/codeaashu/grokbot-shim)
- [Cua Driver integration notes for Grok Bot](https://github.com/trycua/cua/blob/main/docs/content/docs/use-cua-with/grok-bot.mdx)

Qorpera implementation compared:

- `supabase/CLOUD-CONTROL-PLANE.md`
- `supabase/NATIVE-SUBSCRIPTION-ACCEPTANCE.md`
- `supabase/RUNNER-CONTROL.md`
- `packages/runner-orchestrator`
- `packages/runner-control-broker`

## What Grok Bot officially promises

### Durable computer identity

- Each member receives one managed Linux VM.
- Every Bot owned by that member shares the VM, filesystem, browser sessions, command-line credentials, and installed applications.
- Each Bot has a separate screen so multiple Bots can use desktop surfaces in parallel, but the screens are not security boundaries.
- Closing every member device does not stop cloud turns or routines.
- Killing or recovering a member computer recreates its physical VM while retaining durable storage.
- `/workspace` is the documented durable work location. Temporary directories, manually installed packages, and uncommitted application state are explicitly replaceable.

### Interaction and recovery UX

- The conversation exposes an **Agent Computer** view showing live desktop activity.
- The member can take over the remote desktop for passwords, passkeys, MFA, CAPTCHA, payments, and other human-only steps.
- Update, Recover, and Reset are separate user-visible actions. Update and Recover rebuild compute while preserving durable state; Reset may roll durable state back.
- The product prefers structured connectors over browser automation and exposes approvals before consequential actions.
- Routines have explicit test runs, recent run history, schedules, failure states, and an owning Bot.

### Team and provider model

- The VM is dedicated per member, not per team or Bot.
- Organization administrators can remove a member's running VM while retaining durable storage.
- Hosted MCP OAuth tokens remain in the backend and tool calls execute on the computer's behalf; the member VM does not store those hosted tokens.
- The model is selected and failed over by the product. Members do not choose a provider identity for each turn.

## Observed implementation shape

The available evidence consistently describes a small remote-execution service inside a managed Linux environment rather than a desktop application acting as the durable scheduler.

### Machine and desktop layers

- One observed Cursor Cloud Agent ran in a Firecracker microVM with an Ubuntu 24.04 Docker container, a purpose-built PID 1, and a local execution daemon.
- The indexed Grok Bot inventory described Debian 13 in a container under KVM, with 8 vCPUs, about 16 GiB RAM, no GPU, an overlay root, and a separate `/workspace`.
- The independent shim launches a pinned `cursorenvironments/universal` image with Docker and persists exactly three named volumes: `/workspace`, the Chrome profile, and agent data.
- The desktop stack is conventional and replaceable: XFCE, Chrome, TigerVNC, noVNC/websockify, D-Bus, and software rendering.

The distributions differ across observations. The lesson is not “use Debian” or “use Ubuntu”; it is “keep the base image replaceable and make only declared volumes durable.”

### Control surfaces

- The observed exec daemon exposes an authenticated RPC service for tools and a separate PTY WebSocket service.
- noVNC/VNC is separate from the agent tool RPC and is normally loopback/internal only.
- Health and readiness are independent: the shim checks both the noVNC page and an execution `/health` endpoint before declaring the Computer ready.
- Assignment authority is represented by runtime authentication tokens, and the daemon reports traces, tool events, artifacts, and screen state through explicit services.
- The independent shim's Computer lifecycle is only `create/start/stop/restart/status/logs`. Its persistent named volumes survive container recreation.

### Native subscription experiment

The independent shim can read a pre-existing `codex login` profile and call the ChatGPT Codex backend, but it does so through a custom model translation gateway. It parses and refreshes OAuth material itself, synthesizes provider requests, can fall back to another configured model after subscription errors, and writes complete request bodies to local capture logs.

That is useful proof that a cloud Linux boundary can retain a personal Codex login, but the credential and traffic path is deliberately incompatible with Qorpera's production contract. Qorpera requires the unmodified official native harness to own subscription traffic, forbids silent provider substitution, and forbids application/control-plane code from parsing the plaintext credential.

## Patterns Qorpera should adopt

### 1. Logical computer, replaceable realization

Expose one durable logical Compute Identity while making the VM a replaceable realization. The product should say **Start**, **Wake**, **Recover**, **Update**, and **Reset** against that logical identity, not expose raw VM IDs as the user's durable object.

### 2. Explicit persistence classes

Every image and service must declare state as one of:

- canonical cloud state in Supabase;
- immutable object/revision state in the NAS gateway;
- encrypted Compute Identity capsule or checkpoint in object storage;
- explicitly persistent but non-authoritative VM cache;
- disposable local cache.

There must be no generic “the VM disk is durable, therefore the work is safe” category.

### 3. Separate agent RPC from human takeover

Use distinct capability surfaces:

- job-scoped runner control for agent execution;
- session-scoped console/takeover for a named login or interactive computer;
- infrastructure-only lifecycle control between orchestrator and provider.

A noVNC or SPICE session never grants runner, provider, or control-plane authority by implication.

### 4. Observable readiness

Provisioning is complete only after:

- the VM exists with the expected immutable template and policy hashes;
- cloud-init or image initialization completed;
- the runner registered under the assignment capability;
- heartbeat and lease renewal are healthy;
- native-harness and object-materialization checks pass;
- the optional desktop/takeover service is ready independently.

### 5. Recovery-oriented UX

Borrow the visible distinction between Update, Recover, and Reset, but make the exact checkpoint/revision impact explicit before confirmation. Recovery must never silently promote an unverified local worktree or stale provider session into canonical cloud state.

### 6. Pinned images and small host daemons

Pin host package, VM image, cloud-init bundle, runner, native harness, and desktop-stack versions. Put lifecycle logic behind the existing provider contract instead of embedding hypervisor calls in the client or Supabase function.

### 7. Background execution as a product invariant

Treat “all member devices offline” as a normal architecture path, not a special mode. The client should only submit durable work and later subscribe to canonical events.

## Grok assumptions Qorpera must reject

| Grok Bot behavior | Qorpera requirement |
| --- | --- |
| All Bots for one member share files, browser logins, and CLI credentials | Compute Identity and security-boundary ownership are explicit; personal provider capsules are member-owned and never become roster-wide credentials |
| One shared mutable `/workspace` is the durable handoff surface | Company File objects and revisions are authoritative; every run receives an isolated checkout and publishes a validated revision or proposal |
| Product-managed model routing and automatic failover | Every run pins exactly one sponsor and provider connection; no quota-based substitution or silent fallback |
| Custom model gateway may hold and translate provider traffic | Personal subscription traffic is issued only by the official Codex or Claude harness inside the authorized VM |
| Screens separate concurrent Bots but not their security boundary | Separate full VMs are required when credentials, ownership, or policy boundaries differ |
| User/account computer is the main durable product boundary | Qorpera company sessions, transcript, jobs, and run history are cloud-authoritative and survive every computer |
| Local execution depends on a desktop-side heartbeat bridge | Step 2 execution depends only on Qorpera-owned cloud nodes; member-device execution remains an optional separately consented capability |
| Model-based auto-review is a primary enforcement layer | Database authorization, scoped capabilities, leases, receipts, and sandbox policy enforce the boundary; model review is defense in depth only |

## Host platform decision

### Options considered

| Host | Advantages | Costs and risks | Decision |
| --- | --- | --- | --- |
| Proxmox VE on Debian | Mature hypervisor UI, QEMU lifecycle, snapshots, storage administration, console, clustering path | Second host distribution; duplicate management concepts; provider tied to Proxmox API before its extra operations value is needed | Supported fallback |
| Ubuntu Server 26.04 plus LXD full VMs | Matches proven Ubuntu direction; QEMU VM isolation; REST API; projects, quotas, snapshots, images, cloud-init, console; one host/guest operating-system family | Less turnkey datacenter UI; provider journal, backup policy, and narrow administration service remain Qorpera work | **Selected for first node** |
| Ubuntu plus raw libvirt | Small dependency set and direct QEMU control | Requires substantially more custom API, operation tracking, image, console, quota, and snapshot plumbing | Rejected for first node |
| Ubuntu plus Docker/system containers only | Fastest startup and closest to the independent Grok reconstruction | Shared kernel is insufficient as the only personal credential boundary and weakens future desktop isolation | Development-only |

### Selected first-node topology

1. Install Ubuntu Server 26.04 LTS on bare metal.
2. Install and pin a supported LXD 6.x release after recording package/source and image identifiers.
3. Run a minimal host provider service under systemd. It alone may access the LXD Unix socket.
4. Autostart a restricted management VM containing the standalone Runner Orchestrator. It has a Qorpera provider capability, not LXD administrator access.
5. Create login and native execution lanes as full Ubuntu VMs from signed, pinned images.
6. Use LXD projects and limits for operational quotas, while retaining ownership and authorization in Supabase.
7. Publish no public LXD, VNC, SPICE, or runner endpoint. Tailscale/private networking and short-lived Qorpera capabilities gate management and takeover.

### Fallback criteria

Switch the provider adapter to Proxmox before production only if the first-node soak test demonstrates one of these blockers and it cannot be corrected without building an inferior local hypervisor control plane:

- unreliable idempotent VM create/resume/stop reconciliation;
- inability to restore a pinned VM/checkpoint safely after host restart;
- insufficient project, network, disk, or console isolation;
- unacceptable operational recovery from a failed host upgrade;
- a proven Step 3 GPU or desktop requirement that LXD cannot meet safely.

The Supabase, orchestrator, runner, sponsor, capsule, transcript, and Company File contracts must not change if the provider adapter changes.

## Step 2 versus Step 3 lesson

Grok Bot combines headless execution and a persistent interactive desktop from the beginning. Qorpera should not.

Step 2 needs full VMs because native subscription identity is already a sensitive execution boundary, but it only needs a temporary login/takeover surface and headless native turn execution. Step 3 adds the persistent browser, XFCE/Wayland desktop, screen streaming, input arbitration, application installation, long-lived workspace cache, GPU policy, and human/agent shared-control UX.

The Grok desktop stack is therefore a strong Step 3 reference. Its replaceable image, persistent browser profile, separate screens, noVNC takeover, and recover/update/reset vocabulary should influence that phase. It does not justify making a desktop filesystem authoritative in Step 2.

## Implementation implications for the current contracts

The merged Step 1 contracts already cover the important differences:

- acquisition ID equals immutable run ID;
- provider acquisition is idempotent across lost responses;
- assignment capability is short lived and hashed in durable state;
- runner registration, heartbeat, claim, lease, and revocation are cloud-authoritative;
- sponsor, provider connection, Compute Identity, native harness, and Company File revision are pinned before dispatch;
- provider adapters reconcile independently of notifications;
- personal native execution cannot use a generic Qorpera model gateway.

The Step 2 LXD adapter must add:

- a durable local operation journal keyed by run/acquisition ID and VM identity;
- image, profile, project, cloud-init, policy, and disk identifiers on every acquired runner;
- reconciliation for `creating`, `starting`, `registered`, `assigned`, `stopping`, `stopped`, and `lost` physical states;
- a boot-scoped runner registration token delivered without command-line or log exposure;
- encrypted Compute Identity volume attach/detach fencing;
- separate login-VM and job-VM profiles;
- console/takeover capabilities that cannot be replayed as runner assignments;
- idle stop and recycle rules that never delete unpublished canonical output;
- node restart and provider restart acceptance tests;
- evidence that a revoked connection cannot renew or reacquire a native lease.

## Conclusion

Grok Bot validates the product premise that a member can treat a cloud computer as a persistent teammate workspace while every physical device is offline. Its strongest lessons are the logical-computer UX, explicit recovery actions, image replacement with retained declared state, separate human takeover, and a small authenticated execution daemon.

Qorpera's differentiator is that the company, session, transcript, sponsor provenance, provider identity, and Company File remain cloud-authoritative outside every computer. The first node should therefore use Ubuntu Server plus LXD full VMs as a replaceable provider substrate, not copy Grok Bot's shared credential pool, shared mutable workspace, or model-routing authority.
