# Native subscription cloud acceptance

**Status:** Required release gate. Not yet passed.

This acceptance test is the minimum evidence that personal ChatGPT/Codex and
Claude subscriptions are usable through the Qorpera cloud execution path. Unit,
SQL, fake-runner, deterministic-provider, and local process-provider tests are
prerequisites; none of them count as completion of this gate.

Do not describe personal native-subscription execution, autonomous cloud
execution, or all-member-devices-offline execution as working until every
mandatory assertion below has passed against a deployed environment.

## Security and ownership boundary

- Qorpera application and control-plane code must never receive, parse, log, or
  store a plaintext provider credential. The official Codex or Claude harness
  receives it only inside the authorized execution boundary.
- This is an application-security boundary. Until confidential, remotely
  attested compute is deployed and verified, the test must not claim that the
  infrastructure operator is cryptographically unable to inspect a VM.
- A Member Compute Identity is durable cloud state with an encrypted capsule;
  its physical VM or microVM may stop, suspend, or be replaced.
- Compute Identity ownership must remain one of `member`, `company`,
  `department`, or `security_boundary`. A personal subscription used in this
  test must remain `member` owned. It must not be relabeled as a company
  credential.
- Every run must pin exactly one sponsor binding version and one provider
  connection version. There is no pooling, failover to another member, or
  quota-based substitution.
- Personal provider traffic must be issued by the unmodified provider-native
  harness. The Pi compatibility adapter and the generic Qorpera model gateway
  must not receive or proxy this traffic.

## Deployment prerequisites

This functional acceptance may run while the NAS is disconnected. In that
case, configure clients and `company-file-verifier` with
`QORPERA_OBJECT_STORAGE_PRIMARY=supabase`, keep admitted catalog rows on the
`supabase-storage` backend, and run artifact cleanup through that backend. The
objects are real content-addressed Supabase Storage objects, not fixtures. Do
not configure a fake NAS gateway. Production remains NAS-primary with Supabase
backup and requires separate replication, restore, failover, and failback
evidence.

Record immutable image, package, migration, and source commit identifiers for
each deployed component before starting.

1. Apply the cloud control-plane, runner-orchestrator, native Compute Identity,
   runner provisioning, native execution lease, orchestrator token-rotation,
   and explicit Supabase object-promotion migrations through
   `20260823000000_supabase_object_promotion.sql`.
2. Deploy the `runner-control`, `runner-broker`, `runner-orchestrator`, and
   `native-provider-login` Edge functions with their documented authentication
   settings.
3. Deploy the standalone Runner Orchestrator. Its durable control-token state
   must survive restart and its poller must continue without any desktop app.
4. Deploy a provider service that can create or reuse a dedicated cloud VM or
   microVM, register the physical runner, deliver the one-job assignment
   capability, and stop or recycle the runner. A developer process on a member
   device is not acceptable.
5. Deploy the native login host inside the declared VM or microVM boundary and
   configure the Edge function's `QORPERA_NATIVE_PROVIDER_UPSTREAM_URL` to its
   HTTPS endpoint. The login host and runner-side native host must receive the
   capsule master key through the trusted runner-infrastructure secret boundary.
   Orchestrator, desktop, Edge, and control-plane processes must not receive the
   key value. Until an external KMS and attested key release are deployed, do
   not claim that the infrastructure provisioner or operator is cryptographically
   unable to access the key or microVM.
6. Install pinned, supported official Codex and Claude binaries in the Compute
   Identity template. Record their versions. Do not replace either binary with
   a fake harness for this test.
7. Verify that each provider's enabled technical policy matches the deployment's
   approved terms and record the applicable approval or commercial reference.
   Deployment authority may still disable either provider independently;
   passing this test does not itself decide a future legal/commercial change.
8. Prepare current Windows and macOS Qorpera builds from the same source commit.
   The two clients must use different user accounts and must join the same cloud
   company.
9. Configure logs, traces, crash reports, and evidence collection to redact
   credentials, login codes, capsule ciphertext, bearer capabilities, and lease
   tokens. Evidence may contain opaque IDs, hashes, versions, timestamps, and
   terminal statuses.

If the native login upstream, managed provider, orchestrator, official CLI, or
provider enablement is absent, stop. A safe `503` or denied lease is correct
failure behavior, but it means the product gate has not passed.

## Test identities

Use two real members in one company:

| Member | Client used for setup and verification | Personal connection |
| --- | --- | --- |
| A | Windows | ChatGPT/Codex subscription |
| B | macOS | Claude subscription |

The two provider assignments may be exchanged if the available test accounts
require it. Each provider path must still be exercised by its account owner.
Neither account may be shared with the other member.

Create one shared company session with one logical staff agent. Give both
members access to the session and use unique, non-secret prompt markers so the
canonical ordering is unambiguous.

## Acceptance procedure

### 1. Create and connect both Member Compute Identities

On Windows as member A:

1. Select **Create Member Compute Identity**.
2. Select **Connect ChatGPT / Codex**.
3. Complete the official `codex login` or device-auth flow inside A's isolated
   cloud Compute Identity.
4. Create the member sponsor when the connection becomes ready.

On macOS as member B:

1. Select **Create Member Compute Identity**.
2. Select **Connect Claude**.
3. Complete the official `claude auth login` flow inside B's isolated cloud
   Compute Identity.
4. Create the member sponsor when the connection becomes ready.

For each member, capture sanitized control-plane evidence proving:

- `ownership_kind = member` and `owner_user_id` is the authenticating member;
- the provider, authentication mode, official native harness, connection ID and
  immutable connection version;
- the consented sponsor binding ID and immutable sponsor version;
- an opaque encrypted capsule/checkpoint reference, with no plaintext token or
  refresh token column, response field, log field, or desktop state;
- the configured personal concurrency limit, initially one unless the provider
  explicitly authorizes more.

Restart the physical client after each login and verify the ready connection is
discovered from durable cloud state. The official login must not be repeated
merely because the member's physical device restarted.

### 2. Execute A's sponsored shared-session turn in the cloud

1. Stop or pause the orchestrator before submitting the turn so the queued
   boundary can be observed deterministically.
2. On Windows, select A's exact sponsor in the shared-session composer and send
   a prompt containing marker `A_NATIVE_TURN_1`.
3. Record the durable session input ID and run ID. Verify the run pins A's exact
   sponsor version, provider connection version, Compute Identity, native
   harness, and worker class before dispatch.
4. Exit Qorpera on both Windows and macOS, then power off or network-isolate both
   physical member devices. Confirm neither desktop process nor a member-owned
   local runner remains connected.
5. Resume the cloud orchestrator. It must transactionally claim the existing
   run, create or resume an isolated cloud worker, issue the job-scoped
   assignment, acquire A's exclusive provider-connection lease, and invoke the
   official Codex harness.
6. Wait for the durable run to reach a terminal success state using
   cloud-service observability only. Do not reopen either member device to help
   execution.
7. Start macOS first. The response must synchronize from the canonical Qorpera
   transcript, in order, without A's machine. The response provenance must show
   A's sponsor, OpenAI/Codex provider connection, native harness, and exact run.
8. Start Windows and verify the same transcript entry, content hash, run ID, and
   sponsor provenance appear there.

This step is the all-member-devices-offline acceptance. A run executed by a
background process on either test client fails the gate.

### 3. Change sponsor without changing the logical session

1. In the same shared Qorpera session, select B's sponsor on macOS and send a
   prompt containing marker `B_NATIVE_TURN_1` that depends on the prior canonical
   conversation.
2. Repeat the pause, queue, shut-down, cloud-resume, and cross-device sync
   sequence from step 2.
3. Verify the new run pins only B's sponsor and Anthropic connection.
4. Verify the official Claude harness receives canonical transcript context and
   produces the response. The runtime attachment/provider-session identity must
   differ from A's attachment; Qorpera must not copy A's provider-native session
   ID into B's run.
5. Verify both devices display one canonical logical conversation and distinct
   per-turn sponsor/provider provenance.

### 4. Prove personal entitlement is not multiplied

1. Keep one A-sponsored run actively leased inside the official Codex harness.
2. Queue a second A-sponsored run from another shared session.
3. Provisioning additional rented computers must not create a second active
   native-provider lease for A's connection while its concurrency limit is one.
4. The second run must remain durably waiting and later execute under the same
   connection only after the first lease is released. It must not use B's
   connection.
5. Repeat for B's connection and Claude harness.

### 5. Revoke and prove future denial

1. Pause the orchestrator and queue a new A-sponsored turn with marker
   `A_REVOKED_TURN`.
2. As A, select **Revoke** on A's personal provider connection.
3. Resume the orchestrator. The queued run must be durably denied or
   terminalized before native execution. No runner may acquire a new A
   provider-connection lease and the official Codex harness must not be invoked.
4. Attempt another A-sponsored send. The product must reject the unavailable
   sponsor instead of silently selecting B, a company account, or API billing.
5. Submit a B-sponsored turn. It must still execute successfully, proving that
   revocation is connection-scoped rather than company-wide.
6. Confirm both clients synchronize the revoked/denied status and that all
   historical successful turns retain their original A provenance.

Also revoke during one deliberately held active native lease. Future broker and
lease-renewal calls must be fenced immediately; any already-dispatched provider
request must enter the durable terminal/ambiguous accounting path rather than
being erased or retried under another sponsor.

## Evidence bundle

Retain one redacted bundle containing:

- source commit, client build IDs, migration version, Edge deployment IDs,
  orchestrator build ID, provider image/template IDs, and official CLI versions;
- company, member, Compute Identity, logical computer, provider connection and
  version, sponsor binding and version, session, input, run, assignment, runner,
  native lease, and provider-session IDs;
- sanitized run events showing queued, claimed, provisioned, assigned, leased,
  native response, transcript commit, and terminal disposition timestamps;
- screenshots from Windows and macOS showing the same canonical transcript and
  exact sponsor/provider provenance for both turns;
- service evidence proving both member devices were disconnected during each
  cloud execution window;
- revocation event actor/time and the subsequent denial, plus evidence that the
  other member's sponsor remained usable;
- negative assertions that the generic model gateway handled no personal
  subscription request and that no collected control-plane/app log or state
  contains credential plaintext.

Do not include OAuth tokens, refresh tokens, device codes, assignment
capabilities, login capabilities, runner session tokens, lease tokens, capsule
ciphertext, or capsule master keys in the bundle.

## Pass criteria

The gate passes only if:

- both official login flows complete inside their cloud Compute Identities;
- both official native harnesses perform real provider requests using their
  respective member subscriptions;
- the orchestrator provisions cloud execution without any member device;
- one shared canonical transcript synchronizes to both clients;
- every turn displays the exact immutable sponsor/provider provenance;
- sponsor switching reconstructs continuity without sharing provider-native
  session authority;
- the one-connection concurrency lease prevents entitlement multiplication;
- revocation blocks future use without fallback or substitution; and
- the redacted evidence supports every assertion without exposing a credential.

Any missing bridge/provider deployment, simulated provider response, local
desktop execution, manual database repair, sponsor substitution, unavailable
provenance, credential exposure, or required online member device fails the
gate. Record the failure as a deployment or product blocker; do not downgrade
it to a warning.

## Current implementation status

The branch contains the cloud-layer contracts for durable Compute Identity,
ownership, consent, sponsor, exclusive native lease, provenance, revocation,
orchestration, the generic runner-provider boundary, the local process test
adapter, encrypted capsules, and product controls. Local SQL and deterministic
process-provider tests exercise those contracts without a real subscription.

The branch now contains the first-node LXD host/provider contract, a signed-image
provenance gate, a credential-free clean-boot guest image contract, post-boot
credential injection, and an explicit Supabase-primary object acceptance path.
The release gate remains open until the management deployment and native login
host are complete, the provider is enabled from a reviewed signed image, real
Codex and Claude login/provider requests execute through it, the Windows/macOS
builds run this procedure, and all-member-devices-offline behavior is observed.
NAS-primary replication and recovery remain a separate production-storage gate.
