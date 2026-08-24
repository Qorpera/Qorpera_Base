# Step 2 implementation handoff

**Handoff state:** deployed image v20; source fixes after v20 are committed but
not deployed. Step 2 is not complete and no v21 image build was started.

This file is the operational handoff for continuing Step 2. It does not replace
the architecture or acceptance specifications. Read these files in order:

1. [`STEP-2-ARCHITECTURE.md`](STEP-2-ARCHITECTURE.md) for the authoritative
   system boundary and scope;
2. [`../../supabase/NATIVE-SUBSCRIPTION-ACCEPTANCE.md`](../../supabase/NATIVE-SUBSCRIPTION-ACCEPTANCE.md)
   for the mandatory release gate;
3. this file for the exact implementation checkpoint and continuation order;
4. [`README.md`](README.md) for the first-node build, provenance, activation,
   storage, and recovery runbook.

Do not collapse the documented architecture into a desktop runner, a generic
model gateway, a shared provider credential, a mutable NAS checkout, or a
container-only boundary to shorten the remaining work. Step 3 must extend these
contracts rather than replace them.

## Repository checkpoint

- repository: `Qorpera/Qorpera_Base`
- branch: `codex/step2-first-node`
- draft pull request: [#81](https://github.com/Qorpera/Qorpera_Base/pull/81)
- deployed v20 source commit: `e98f7ac5624fe20bccd4e6e242cb070b30c25e32`
- handoff source commit before this document: `e9a83b03fb2828a133224fc94583038f091c21ed`
- source commits after v20:
  - `2eb7a15436fb9de47af64fb7898069943b27da00` fixes strict Company
    File references and adds regression coverage;
  - `e9a83b03fb2828a133224fc94583038f091c21ed` pins that corrected
    runner guest package in the image recipes.

At handoff, the branch is clean and synchronized with its remote. Pull request
#81 is open, draft, and mergeable. Its migration, SQL, LXD contract, and rootless
Podman checks pass. The private keyless-signed image export check is skipped in
ordinary pull-request CI and therefore is not release evidence.

The `.artifacts/lxd-image-v21` and `.artifacts/lxd-runner-guest-v21` directories
are local staging residue only. They do not identify a built, accepted, signed,
or deployed image. Preserve v20 as the deployed boundary until the next
candidate completes every image gate.

## Intended architecture that must remain intact

```text
Windows/macOS cloud clients
        |
        v
Supabase control plane and canonical transcript
        |
        v
standalone Runner Orchestrator in its management VM
        |
        v
narrow first-node provider service (sole LXD administrator)
        |
        v
one isolated LXD full VM per execution lane
        |
        +-- official Codex or Claude native harness
        +-- identity-bound encrypted provider capsule
        +-- immutable Company File materialization
        +-- assignment lease, receipts, events, and output staging
        |
        v
strict Company File verifier -> canonical publication/transcript
```

Supabase remains authoritative for membership, sessions, turns, jobs, leases,
sponsor/provider bindings, transcript order, receipts, runner state, and the
immutable object catalog. The production object topology remains NAS-primary
with durable Supabase backup. Supabase-primary is an explicit acceptance mode,
not an implicit production fallback.

Personal subscription traffic must run through the official Codex or Claude
harness inside the VM. Pi and a generic Qorpera model gateway must not receive
or proxy it. A turn pins one sponsor, provider connection, Compute Identity,
native harness, and immutable Company File revision. Connections are not
pooled, substituted, or multiplied by creating more VMs.

## What deployed v20 proves

The v20 image has signed provenance and passed credential-free clean-boot
acceptance with these immutable values:

| Item | Value |
| --- | --- |
| LXD image fingerprint | `6bac8e025d6e8209129bba729844ee43dc67c5753bdb85c3873f4e55fd03d35d` |
| Base fingerprint | `7ef31bed9834094a06517d63b93434588049efcbe2ab5d67419a6167988b7d4f` |
| Guest manifest SHA-256 | `e05375e8fd4f0fd5fffed85a4de8286d4b5392bddefa58a5a2bafbeab4889144` |
| Acceptance evidence SHA-256 | `f0d36ff369993c3cf1d24e152694aa3f1dd8019c66abffc6cd489224cc7b23e7` |
| Build source | `e98f7ac5624fe20bccd4e6e242cb070b30c25e32`, clean tree |
| Boundary | KVM full VM, UEFI Secure Boot |
| Boot contents | credentials absent, identity volume absent, services fail closed |
| Official harnesses | Codex `0.147.0`, Claude Code `2.1.231` |

The provider service on `company41-node-01` is enabled and active. A real
OpenAI/Codex login was completed for one member, and a live hosted turn passed
through the durable orchestration and VM path:

- marker: `STEP2_LXD_OPENAI_SMOKE_20260824194856`
- turn/run: `8c7395be-3759-41db-8758-0283f97bacbe`
- job: `1858d48a-f94a-4992-b79c-cfd5a9ce680a`
- VM: `qorpera-8c7395be375941db87580283f97bacbe`
- reconstructed workspace: 515 files, about 416 MB
- candidate snapshot: `ef88bb27-29ec-45bc-bd0e-c847f1591ef6`
- reachability graph: `7adbbfe4-2248-4f20-abb2-cbb155a59c7f`
- graph: complete, 156 objects, 145,961,371 bytes

That run proved VM acquisition, assignment delivery, native authority renewal,
workspace reconstruction, native harness execution, candidate upload, durable
event recording, and authority release. It did not produce a canonical
assistant transcript entry. The run terminalized as failed and entered the
durable review path.

## Current blocker and already-committed correction

The v20 runner sent the candidate tree to `company-file-verifier`, which
returned HTTP 422 with `Invalid Company File reference`. Private reachability
metadata named `objects` had leaked into a public tree file reference. The
strict public reference permits exactly:

- `manifestSha256`;
- `fileSha256`;
- `bytes`;
- `mediaType`.

Commit `2eb7a1543` separates the private reachability helper data from the
serialized public reference. Commit `e9a83b03f` pins the resulting guest
package. Focused Company File tests, verifier tests, package tests,
`npm run check`, and pull-request CI pass.

This correction is not deployed. The next action is not another architecture
change: it is a new immutable image candidate containing these commits, followed
by the same clean-boot, signing, activation, and live-turn evidence gates.

## Deterministic continuation sequence

Do not enable a candidate merely because it builds. Execute these gates in
order and retain redacted evidence for each one.

### 1. Reconfirm source and tests

```sh
git status --short --branch
git log -3 --oneline
npm run check
```

Run the focused tests touched by `2eb7a1543` and the Company File verifier tests
before packaging. Use the repository test commands described in `AGENTS.md`.

Add a shared golden contract test between the Company File producer and
verifier before release if one does not already exercise the exact serialized
tree. This specific defect should be rejected before an image build.

### 2. Package and stage a fresh candidate

```sh
npm run pack:lxd-runner-guest
npm run pack:lxd-provider
npm run pack:runner-orchestrator
```

Inspect every generated manifest and digest. The checked-in image scripts still
use explicit candidate names; assign a new unused alias, builder VM, acceptance
VM, staging directory, and manifest digest. Never overwrite or relabel v20.
Copy only the reviewed artifacts and scripts to
`/home/company41-admin/step2-lxd` on `company41-node-01`.

### 3. Build and accept without credentials

On the node, run the reviewed build and verifier scripts through interactive
`sudo`. The acceptance VM must prove:

- full QEMU/KVM VM;
- UEFI Secure Boot;
- exact guest-package and nested OCI image digests;
- no provider credential;
- no Compute Identity volume;
- disabled native services and fail-closed boot.

Do not use the build VM or an earlier acceptance VM as evidence.

### 4. Sign off-node and activate the exact fingerprint

Create and sign provenance on the Mac using the approved off-node Ed25519 key.
The statement must bind the clean source commit, exact image fingerprint, guest
manifest, nested OCI image, keyless Cosign bundle, and retained clean-boot
evidence. Install only the public key and signed envelope on the node. Activate
only after independent verification succeeds.

### 5. Repeat the live Codex turn

Use a new non-secret marker. Confirm all of the following without manual
database repair:

1. queued input becomes a durable run and job;
2. the orchestrator claims it and the provider creates an isolated VM;
3. the native connection lease remains valid throughout execution;
4. the exact Company File revision materializes and verifies;
5. the official Codex harness returns a real provider response;
6. the output snapshot and graph pass `company-file-verifier`;
7. the canonical transcript receives the assistant response and provenance;
8. the run and job reach `completed`;
9. the connection lease is released;
10. the worker is stopped, recycled, or deleted according to the recorded
    cleanup policy.

If the run fails, preserve the candidate and logs, but do not increment images
repeatedly from guesses. Reproduce the failed producer/verifier contract with a
small local fixture first.

## Step 2 work remaining after the immediate fix

The live Codex success is necessary but is not the Step 2 release gate. The
following work remains mandatory:

### Functional acceptance

- Complete one real member-owned Claude login and official Claude request.
- Use two real members and current Windows/macOS clients in one company.
- Execute both sponsors in one shared canonical session.
- Prove sponsor switching reconstructs context from the canonical transcript
  without sharing provider-native session authority.
- Prove both clients synchronize identical transcript content, hashes, run IDs,
  and immutable sponsor/provider provenance.
- Hold a connection lease and prove concurrency one prevents entitlement
  multiplication even when additional VMs are available.
- Revoke a connection before execution and during a held lease; prove future
  broker calls and renewals are denied without sponsor substitution.
- Repeat the real executions while every physical member device is offline.
- Record the required provider-policy/commercial approvals and a redacted
  evidence bundle.

### Storage and recovery production gate

- Verify the restored NAS object gateway and configure production explicitly as
  `QORPERA_OBJECT_STORAGE_PRIMARY=nas`.
- Prove immutable publication to NAS and durable replication to Supabase.
- Prove restore from Supabase to replacement NAS storage.
- Prove NAS failure closes access instead of silently moving authority.
- Test stale, replayed, wrong-company, wrong-identity, and unsigned recovery
  material.
- Perform a replacement-node drill that restores the same Compute Identity
  master key and decrypts existing capsules. Today loss of the persistent
  identity volume can lose capsule access; no fallback key may be synthesized.

### Operational and release gate

- Define and test marker-owned VM cleanup/recycling for success, failure,
  timeout, and ambiguous effects.
- Resolve or explicitly discard the v20 `review_pending` candidate.
- Propagate safe structured failure codes through verifier, broker, runner, and
  observability; the generic v20 broker 503 obscured the actionable 422.
- Reduce the approximately 11-minute, 416 MB workspace execution loop after
  correctness is proven.
- Run the real private keyless-signed image export workflow; a skipped CI job is
  not evidence.
- Update the acceptance documents with redacted immutable evidence.
- Remove draft status, review and merge pull request #81, then cut a release
  from the accepted source commit. Do not release directly from the deployed
  v20 source because it contains the rejected Company File serialization.

## Definition of Step 2 complete

Step 2 is complete only when every assertion in
`supabase/NATIVE-SUBSCRIPTION-ACCEPTANCE.md` passes. In compact form, two real
members must create cloud Member Compute Identities, complete isolated official
Codex and Claude login, run both sponsors in one canonical shared session,
observe identical responses and provenance across devices, switch sponsor while
preserving canonical context, prove concurrency fencing and revocation, and
repeat execution while all member devices are offline.

The NAS-disconnected Supabase-primary profile can prove this functional gate.
It cannot prove the separate NAS-primary production storage, replication,
restore, failover authorization, failback, or Compute Identity recovery gate.

Until both applicable gates pass, describe the system as a deployed control
plane and substantially proven compute boundary, not completed autonomous cloud
execution.
