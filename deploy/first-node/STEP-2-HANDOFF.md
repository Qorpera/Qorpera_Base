# Step 2 implementation handoff

**Handoff state:** deployed image v20; the v21 candidate is packaged, contract
tested, and signed-export backed, but not yet built, accepted, signed, or
activated on the node. Step 2 is not complete.

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
- source commits after v20:
  - `2eb7a15436fb9de47af64fb7898069943b27da00` fixes strict Company
    File references and adds regression coverage;
  - `e9a83b03fb2828a133224fc94583038f091c21ed` pins that corrected
    runner guest package in the image recipes;
  - `135b4fc7b40f70a0fd6859fb9400fbb42d820ebc` adds the shared
    producer-verifier golden contract test and runs it plus the full
    verifier suite in step2-lxd CI;
  - `ce721cb02` pins the v21 candidate recipe: the real keyless-signed
    runner image export and the v21 staging, builder, alias, and
    acceptance names.

The branch is clean and synchronized with its remote. Pull request #81 is
open, draft, and mergeable, and its checks pass. The private keyless-signed
image export ran for real via `workflow_dispatch`
([run 32775544896](https://github.com/Qorpera/Qorpera_Base/actions/runs/32775544896))
against source `135b4fc7b`; its Cosign bundle was independently verified
off-node with `cosign verify-blob`. Preserve v20 as the deployed boundary
until the v21 candidate completes every image gate.

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
package. Commit `135b4fc7b` adds the shared golden contract test
(`packages/shell/test/cloud-company-file-contract.test.ts`) that feeds the
producer's exact serialized tree through the deployed verifier closure and
asserts the v20 leak shape is rejected with `Invalid Company File reference`;
step2-lxd CI runs it and the full verifier suite on every pull request.
Focused Company File tests, verifier tests, package tests, `npm run check`,
and pull-request CI pass.

This correction is not deployed. The v21 candidate containing these commits
is packaged and staged off-node; the remaining work is the node build,
credential-free clean-boot acceptance, off-node signing, activation, and
live-turn evidence gates.

## Deterministic continuation sequence

Do not enable a candidate merely because it builds. Execute these gates in
order and retain redacted evidence for each one.

### 1. Reconfirm source and tests — done for v21

`npm run check`, the step2 focused vitest batches, the packaging tests, and
the verifier `node --test` suites pass at `ce721cb02`. The mandated shared
golden contract test exists (`cloud-company-file-contract.test.ts`) and runs
in step2-lxd CI, so the v20 serialization defect is rejected before any image
build.

### 2. Package and stage a fresh candidate — packaged for v21

The real signed export (run 32775544896) was downloaded, Cosign-verified
off-node, and pinned into `deploy/lxd-runner-guest/runner-image-contract.json`.
The v21 packages rebuild deterministically from the clean tree:

| Artifact | Value |
| --- | --- |
| Guest package manifest SHA-256 | `36aa29c8b5f8fd823e88d8cce6b74f3ae72c1944aa69b5f525f24c2e38e0b045` |
| Runner OCI archive SHA-256 | `c9370c825bdbd589bf0c1391e567b8f5ea8ba36161cc554b32fcfb235f046239` (84,122,624 bytes) |
| Cosign bundle SHA-256 | `98a00fefd625c9aceeadd746ee610682a8787e5ce85ec0a6ac513a354a7491ce` (10,639 bytes) |
| Nested runner image | `localhost/qorpera/sandbox-probe:135b4fc7b40f70a0fd6859fb9400fbb42d820ebc@sha256:adda31f15d111ed8a06d4d773bac9d8d309047e09862642a292068d62b9b60e1` |
| Provider package | unchanged from deployed pins (`cb1efa25…`, provenance tool `316006eb…`) |
| Orchestrator package | unchanged from deployed pins (`ec1378d2…`) |

The provider and orchestrator digests match the already-installed node pins,
so only the guest package changes for v21. The staged copy set (guest package,
v21-pinned build and verify scripts, `SHA256SUMS.v21`) is assembled under
`.artifacts/step2-lxd-staging-v21` on the Mac. Copy it to
`/home/company41-admin/step2-lxd` on `company41-node-01`, replacing any stale
`lxd-runner-guest-v21` directory, and re-verify `SHA256SUMS.v21` on the node.
Never overwrite or relabel v20.

### 3. Build and accept without credentials — next action

On the node, after the staged `SHA256SUMS.v21` re-verifies, run the reviewed
v21-pinned scripts through interactive `sudo`:

```sh
cd /home/company41-admin/step2-lxd
shasum -a 256 -c SHA256SUMS.v21
sudo bash build-lxd-runner-image-candidate.sh
sudo bash verify-lxd-runner-image-candidate.sh
```

Both scripts fail closed on a wrong hostname, staging digest, runner-image
reference, or an existing v21 alias. The acceptance VM must prove:

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

For v21 the statement values are fixed except the two node build outputs
(image fingerprint and acceptance evidence digest):

```sh
node .artifacts/lxd-provider/qorpera-lxd-image-provenance.mjs create \
  --image-server local \
  --image-fingerprint REPLACE_V21_IMAGE_FINGERPRINT \
  --base-image-fingerprint 7ef31bed9834094a06517d63b93434588049efcbe2ab5d67419a6167988b7d4f \
  --guest-package-manifest-sha256 36aa29c8b5f8fd823e88d8cce6b74f3ae72c1944aa69b5f525f24c2e38e0b045 \
  --runner-image localhost/qorpera/sandbox-probe:135b4fc7b40f70a0fd6859fb9400fbb42d820ebc@sha256:adda31f15d111ed8a06d4d773bac9d8d309047e09862642a292068d62b9b60e1 \
  --runner-image-archive-sha256 c9370c825bdbd589bf0c1391e567b8f5ea8ba36161cc554b32fcfb235f046239 \
  --runner-image-cosign-bundle-sha256 98a00fefd625c9aceeadd746ee610682a8787e5ce85ec0a6ac513a354a7491ce \
  --source-repository https://github.com/Qorpera/Qorpera_Base.git \
  --source-commit "$(git rev-parse HEAD)" \
  --source-tree clean \
  --tested-at REPLACE_CANONICAL_UTC_TIMESTAMP \
  --acceptance-evidence-sha256 REPLACE_V21_ACCEPTANCE_EVIDENCE_SHA256 \
  --output lxd-image-statement.json
```

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
