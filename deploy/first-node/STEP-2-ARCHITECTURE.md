# Company41 Step 2 first-node architecture

**Status:** implementation plan. This document does not claim that native subscription execution is deployed or production-ready.

## Decision

The first Company41 compute node will run Ubuntu Server 26.04 LTS on bare metal. A pinned, supported LXD 6.x release will provide the QEMU/KVM virtual-machine boundary, lifecycle API, projects, quotas, snapshots, and console needed by the runner-provider service. Login and job workloads will be full Ubuntu virtual machines, not system containers.

Proxmox was considered because it provides excellent turnkey datacenter operations, but it is not required by the Qorpera contracts. Ubuntu plus LXD keeps the proven operating-system baseline on both host and guest, avoids a separate Debian/Proxmox management layer, and still exposes a versioned REST API over a local Unix socket or mutually authenticated HTTPS. Proxmox remains a provider-adapter fallback if the first-node soak test demonstrates an LXD lifecycle, recovery, isolation, or future GPU-pass-through blocker.

The LXD daemon is not part of the Qorpera control plane. A narrow host provider service is the only Qorpera component allowed to administer LXD. The Runner Orchestrator calls that service through the existing `qorpera.runner-provider/v1` contract and never receives the LXD socket, host root credentials, provider OAuth credential, or capsule master key.

This is not a change to the cloud authority model:

- Supabase remains authoritative for companies, memberships, sessions, turns, jobs, runs, claims, leases, sponsor/provider bindings, transcript order, receipts, runner state, and the immutable object catalog.
- The production storage target is NAS-primary with a durable Supabase Storage backup for immutable Company File objects, attachments, artifacts, encrypted compute-identity capsules, and encrypted checkpoints.
- The NAS-disconnected acceptance profile explicitly selects Supabase Storage as the active object backend. It exercises the same hashes, manifests, catalog rows, capabilities, verifier, runner broker, and cleanup workflow; it does not claim to have tested NAS transport, replication, failover, failback, or recovery performance.
- Storage selection is explicit. A production NAS read or write failure must fail closed rather than silently changing authority to the Supabase backup.
- The standalone Runner Orchestrator continuously reconciles Supabase jobs with provider state. Supabase notifications are wake hints, not scheduling authority.
- Physical nodes and guests are replaceable compute. Their Company File checkouts, repositories, provider-runtime state, and workspaces are caches.

Official references:

- [Proxmox VE 9.2](https://www.proxmox.com/en/about/company-details/press-releases/proxmox-virtual-environment-9-2)
- [Ubuntu release cycle](https://ubuntu.com/about/release-cycle)
- [LXD virtual-machine creation](https://documentation.ubuntu.com/lxd/latest/howto/instances_create/)
- [LXD external REST API](https://documentation.ubuntu.com/lxd/latest/api/)
- [LXD projects and resource limits](https://documentation.ubuntu.com/lxd/latest/reference/projects/)
- [NVIDIA Container Toolkit installation and Podman CDI](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)

## First-node topology

```text
Supabase control plane + backup storage        NAS object gateway
  durable jobs, leases, transcript              production primary bytes
  immutable catalog + backup bytes
               |                                           |
               +----------------+--------------------------+
                                |
                    outbound-only reconciliation
                                |
                   Company41 physical node
                   Ubuntu Server 26.04 LTS
                     |
                     +-- host provider service
                     |     sole LXD administrator
                     |     narrow qorpera.runner-provider/v1 API
                     |     idempotent VM lifecycle journal
                     |
                     +-- management VM
                     |     Runner Orchestrator
                     |     no LXD administrative authority
                     |     no provider OAuth plaintext
                     |
                     +-- login VM (temporary physical realization)
                     |     one logical Compute Identity
                     |     official `codex login` or `claude auth login`
                     |     encrypted capsule/checkpoint publication
                     |
                     +-- job VM (one isolated execution lane)
                           assignment-scoped runner
                           official Codex or Claude native harness
                           pinned Company File/repository materialization
                           continuous event/output upload
```

The management VM is a small, autostarted infrastructure guest and is not acquired through the job-provider path it controls. The host provider service has the minimum local authority needed to operate LXD; the orchestrator has only the Qorpera provider capability. Later nodes can run their own provider services, and the orchestrator can be made redundant without changing job or runner contracts.

Host SSH and any remote LXD management endpoint are reachable only over Tailscale or the local management network. The Qorpera provider normally uses the local LXD Unix socket; direct LXD access is never exposed to a runner. Workload guests have no public inbound route. Their egress is limited to the exact Supabase functions, NAS object gateway, provider endpoints, and approved repository endpoints required by the assignment.

For the NAS-disconnected acceptance run, the object route in that last sentence is Supabase Storage. For production it is the NAS gateway plus the separately verified Supabase backup path. The mode is deployment configuration, not an automatic runtime fallback.

LXD projects provide quotas and an additional administrative grouping, but Qorpera does not treat an LXD project as the durable ownership or authorization record. Compute Identity ownership, sponsor authority, execution leases, and security-boundary membership remain canonical in Supabase. Full VM boundaries are used for member subscription identities even where a system container would be cheaper.

## Native subscription boundary

Personal Codex and Claude subscriptions are a primary Step 2 path, not a compatibility option.

1. A member creates a cloud-only Member Compute Identity.
2. Qorpera provisions or resumes an isolated login VM for that logical identity.
3. The member completes the provider's official native login flow. The provider-native harness receives plaintext inside the authorized execution boundary; Qorpera application/control-plane code does not.
4. The login host publishes only an encrypted capsule/checkpoint plus opaque connection identity, ownership, consent, policy, lease, revocation, and provenance records.
5. A turn names exactly one sponsor, provider connection, Compute Identity, native harness, and immutable Company File revision.
6. The orchestrator obtains an exclusive concurrency lease for that provider connection before provisioning or attaching a job VM.
7. The job VM receives a short-lived, assignment-scoped capability. The native host unwraps the capsule only for the official harness and does not expose plaintext through the orchestrator, desktop client, Pi, a generic model gateway, logs, argv, or ordinary job metadata.
8. Events and outputs stream into the canonical Qorpera run and transcript. Provider runtime IDs are resumable hints, not the durable session identity.
9. Revocation invalidates future login/capsule leases and must deny subsequent execution even if an old VM or checkpoint still exists.

The initial deployment is not confidential or attested compute. An Ubuntu/LXD infrastructure administrator may technically inspect a guest. Product language must describe an application security boundary and must not claim cryptographic operator blindness.

Compute Identity ownership supports:

- `member`: required for personal subscription capsules;
- `company`: available for company-owned credentials and Company Computers;
- `security_boundary`: department or other scoped ownership boundary.

Connections are never pooled, silently substituted, or selected based on another member's remaining quota. More job VMs increase physical capacity but do not multiply provider entitlement.

## Step 2 execution lifecycle

1. A client app appends a shared-session input with an explicit sponsor and provider connection.
2. Supabase transactionally creates the immutable run/job and revision pins.
3. The Runner Orchestrator claims the durable job and records a provider acquisition identity before provisioning.
4. The Ubuntu/LXD provider service creates or resumes the correct isolated VM and returns a registered runner identity.
5. The orchestrator issues a short-lived job capability only after runner registration, sponsor/connection authorization, revocation, quota, and exclusive-concurrency checks pass.
6. The runner materializes objects by immutable hash into a private checkout and verifies every pin before native execution.
7. The runner reserves an idempotent attempt receipt, starts the official harness, and continuously uploads deterministic transcript events and artifacts.
8. Completion records immutable outputs before any Company File publication. Publication is a validated compare-and-swap revision or a review proposal, never a shared writable NAS checkout.
9. Infrastructure failures are retried only when receipts prove effects were not completed. Ambiguous effects are fenced for review.
10. The orchestrator continuously reconciles queued jobs, leases, heartbeats, guest state, revocation, and idle shutdown even when notifications are lost.

## Step 2 scope

Step 2 includes:

- a real cloud Member Compute Identity and native-provider connection UX;
- real official Codex and Claude login bridges inside isolated cloud guests;
- a deployable standalone Runner Orchestrator service;
- an Ubuntu/LXD provider implementation with idempotent create/resume/monitor/destroy;
- isolated headless job VMs running the unmodified native harnesses;
- exact sponsor/provider provenance and exclusive connection concurrency;
- canonical transcript reconstruction across sponsor changes and devices;
- revocation and crash/retry proof;
- an explicit Supabase-primary acceptance profile that runs without the NAS;
- a two-member, two-subscription, all-member-devices-offline acceptance test.

Step 2 does not include:

- a persistent interactive desktop presented as a Company Computer;
- browser/GUI Computer Use, visual desktop automation, or human remote-desktop UX;
- GPU allocation, sharing, or RTX 5090 passthrough;
- arbitrary long-lived personal workstations or mutable shared NAS workspaces;
- multi-node placement optimization, high availability, or elastic fleet scaling beyond the provider contract;
- confidential-compute attestation or cryptographic infrastructure-operator blindness.

Those are Step 3 concerns. Step 2 must nevertheless use the same logical-computer, provider, capability, checkpoint, and runner contracts so Step 3 extends it instead of replacing it.

## Current implementation inventory

Merged Step 1 already provides:

- durable Compute Identity, provider connection, sponsor binding, connection concurrency, login intent, capsule/checkpoint, job, run, lease, runner, provider-acquisition, receipt, transcript, revision-pin, and revocation contracts;
- the standalone `packages/runner-orchestrator` reconciliation service and provider interface;
- fake/process provider scaffolding and a native-provider login Edge Function contract;
- job-scoped runner control/broker capabilities and immutable Company File object contracts;
- an explicit acceptance specification in `supabase/NATIVE-SUBSCRIPTION-ACCEPTANCE.md`.

Step 1.5, the release gate immediately before this phase, additionally:

- owns cloud execution and company-domain types in `@qorpera/contracts` and `@qorpera/company` rather than Pi packages;
- prevents the desktop from claiming or executing cloud turns and wakes through the inherited local runtime;
- requires an explicit sponsor/provider connection for every cloud turn;
- retains Pi only behind an explicitly named legacy-local boundary for local-company compatibility; and
- enforces the separation with `npm run check:cloud-boundaries`.

The older unpublished Company Computer prototype is not authoritative. It currently blocks the required subscription path in several places:

- its authentication-mode union omits personal native subscription OAuth;
- its Claude harness accepts API keys only;
- its documentation says not to custody consumer OAuth;
- its credential lease writes application-visible environment/files instead of using the merged native-host capsule boundary.

Useful provisioning, workspace, receipt, transcript, and virtual-machine concepts can be adapted, but those credential paths must be replaced rather than merged unchanged.

## Remaining implementation slices

1. Create and verify the real Company41 account/profile in the clean Supabase project, then import a pinned Company File revision.
2. Deploy and verify the native-provider-login Edge Function and current client configuration.
3. Add the missing owner/admin runner registration entry point with ambiguity-safe activation-token persistence.
4. Rebuild the accepted guest image from a reviewed clean commit, sign its exact provenance off-node, install the reviewed provider package, and deploy the still-disabled service configuration.
5. Build the isolated login-host bridge for official `codex login` and `claude auth login`, capsule encryption/publication, resume, and revocation.
6. Finish deployed end-to-end wiring for the isolated job runner/native sidecar, including transcript streaming, receipt fencing, output staging, and real assignment delivery through the post-boot credential boundary.
7. Package and deploy the management orchestrator, provider configuration, login VM, and job VM as versioned systemd services/templates with redacted logs and outbound-only networking.
8. Add current desktop surfaces for Compute Identity creation, login status, explicit sponsor/connection selection, provenance display, reauthentication, and revocation.
9. Execute the deployed two-member acceptance test with every physical member device offline during the actual turns.
10. Before production launch, implement and test NAS-primary publication plus Supabase backup replication, restore, failover authorization, and failback without weakening the explicit storage boundary.

## Reimage gate

Do not erase the Windows installation until all of these are true:

- the Git/worktree/asset preservation set exists locally and on the NAS with matching SHA-256 checksums;
- the Mac has restored and verified the Git bundle and Company41 workspace archive;
- a real account/profile exists in the clean Supabase project and the Company41 revision is readable from the Mac;
- provider and app credentials that must not migrate have been identified for revocation/re-authentication;
- Ubuntu Server 26.04 LTS installation media and checksums are verified;
- Tailscale/SSH recovery access and a physical-console path are ready.

The current node has one internal 2 TB NVMe. The first proof may use single-disk local VM storage because node-local state is non-authoritative, but it must not claim disk redundancy. A second internal NVMe and tested node-restore automation are production hardening before relying on this as the sole execution host.

## Step 2 completion gate

The functional gate below may run with `QORPERA_OBJECT_STORAGE_PRIMARY=supabase` while the NAS is disconnected. That proves the complete cloud execution and object workflow without substituting mocks. It does not satisfy the separate production-storage gate for NAS-primary replication, restore, failover, and failback.

Step 2 is complete only when two real members can:

1. create their cloud Member Compute Identities;
2. complete official Codex or Claude login in isolated cloud environments;
3. trigger turns in one shared canonical Qorpera session with explicit sponsor/provider provenance;
4. have the orchestrator provision the first node's isolated workers and run the native harnesses;
5. observe responses and provenance synchronize across both devices;
6. switch sponsor and reconstruct provider context from the canonical transcript;
7. revoke a connection and prove subsequent execution is denied;
8. repeat the execution while every physical member device is offline.

Until that gate passes, the system has a deployed control plane and compute contracts, not autonomous cloud execution.
