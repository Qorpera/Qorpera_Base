# Runtime step 1: loop plus mouth

Date: 2026-08-27

Status: implemented and deployed to the production database and signed v45
runner image. Real conversation acceptance is not complete: the released
desktop client fails while opening the NAS-backed Company41, before a test
prompt can be submitted. See the activation record and blocker below.

This is step 1 of the cloud runtime implementation order,
not the earlier infrastructure Step 1. The Company File is the live digital
company. All execution and message authority belong to the cloud. Desktop
clients submit intent and render canonical events; they do not run the mouth.

## Audit: what already exists

| Component | Evidence and disposition |
| --- | --- |
| Live Company File | `/mnt/qorpera-companies` is a writable NFS mount on `company41-node-01`. The company tree reaches a runner as `/qorpera/company-live` through virtiofs. Reused, not rebuilt. |
| Native cloud execution | The signed v44 proof already ran an official provider turn and wrote the NAS-backed tree. See the dated checkpoint in [STEP-2-HANDOFF.md](STEP-2-HANDOFF.md). |
| Cloud dispatcher | `qorpera-lxd-provider.service` on the node and `qorpera-runner-orchestrator.service` in `company41-orchestrator-01` were both active during this audit. |
| Admission and recovery | Existing durable inputs, runs, sponsor/compute bindings, assignment leases, renewals, recovery and completion are retained. |
| Native credentials | The provider host restores an encrypted Compute Identity capsule outside Company File storage; the official harness uses its own native login. No new credential store is introduced. |
| Canonical conversation | Existing session events provide ordering, provenance, realtime discovery and client replay. The new mouth writes into that store. |
| Client execution | Cloud attended sessions are processless client projections; the legacy Pi compatibility lane is not the cloud worker. |

The missing behavior was the provider-to-conversation boundary. The old native
adapter extracted final provider text and appended it after execution. That
could not provide an explicit public voice or deliver progress while the
provider was working. NAS and VM provisioning were not the missing layer.

## Implemented path

```text
admitted cloud run -> existing native provider host -> official native harness
                                                |
                                      run-scoped MCP send_message
                                                |
                              authority check + idempotent database transaction
                                                |
                                  canonical session event -> client rendering

provider stdout / reasoning / ordinary final text -> private capture only
native process completion -> closed private receipt -> existing run completion
```

- `packages/shell/src/cloud-agent-mouth.ts` provides one authenticated,
  loopback-only MCP endpoint per run. It exposes only `send_message` with
  `text`, `phase` (`progress` or `final`), and `idempotencyKey`.
- The model cannot choose the company, agent, run, sponsor or recipient.
  Those are bound by the native host and resolved against durable authority.
  The model receives only a random, short-lived mouth token, never the
  control-plane service credential.
- The database rechecks the current run, assignment, native lease, sponsor and
  compute identity on every send, including retries. A receipt is returned
  only after the canonical event is committed.
- A retry with the same key, text and phase returns the original message and
  sequence. Rebinding a key is rejected. Only one final send is allowed, and
  new messages after it are rejected.
- The ledger stores hashes and receipts, not a second transcript. A database
  trigger rejects raw runner message inserts without an exact send receipt,
  including attempts through the older generic transcript RPC.
- The native harness result is `qorpera.native-harness-result/v2`: run ID,
  message count, final message ID and optional provider-session hint. Unknown
  fields, legacy assistant entries and private text are rejected before the
  runner can persist the result. There is no final-text fallback.
- Conversation turns cannot complete after only a progress acknowledgement.
  Both the host and database require a final send. Jobs without a conversation
  recipient may complete privately with zero messages. This does not yet
  implement routine/room/coworker-specific silence policies.
- Cancellation closes the run's mouth, and effect-time authority validation
  fences stale capabilities. Failed sends return a fixed error, not database
  details or native provider output.
- Context now explicitly identifies cloud execution, the live digital Company
  File, the executing staff identity, its job-specification path and the public
  voice. It does not introduce a company checkout or user commit workflow.
  Existing NAS writes and internal checkpoint/publication plumbing are reused.

The Codex adapter uses an explicit required HTTP MCP server, low reasoning
effort, ephemeral provider sessions and no user configuration. This uses the
supported [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
The existing Claude adapter is configured for the same mouth with explicit MCP,
no session persistence, no file-based settings, and disabled executable hooks;
`--safe-mode` cannot be used because it disables MCP too. These controls follow
the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) and
[hook configuration](https://code.claude.com/docs/en/hooks). Full Claude provider
compatibility and cloud acceptance remain the previously agreed backlog item.

## Verification

Run focused tests from `packages/shell`:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/cloud-agent-mouth.test.ts test/cloud-agent-mouth-delivery.test.ts test/cloud-native-provider-host.test.ts test/cloud-native-provider.test.ts test/cloud-trail-sync.test.ts test/cloud-runner-worker.test.ts test/cloud-runner-broker.test.ts test/cloud-runner-sandbox.test.ts
```

All 81 tests across these eight files pass. They exercise
private-output canaries, immediate sends, lost-response
replay, transport authentication, malformed arguments/receipts, cancellation,
final-delivery obligations, silent no-audience jobs, provider process contracts,
and canonical replay on two read-only clients. Client replay requires no local
model process and makes no authoritative message writes.

`npm run check` passes, including formatting, lint, types, pinned dependencies,
cloud boundaries, lockfile checks and browser smoke checks. No dependencies or
provider keys were added.

The production runner packaging script also passes, including the bundled
native provider host. The signed v45 image was subsequently built and activated
from clean source, as recorded below.

All 72 migrations apply to disposable PostgreSQL 17.6. The new send tests and
the affected runner/native suites pass. The complete SQL sweep passes 29 of 30
suites. `100_session_arbiter.test.sql` retains a pre-existing mismatch with the
2026-08-26 account-trail policy: it submits an invalid event schema while
expecting an authority error. It also asserts the earlier mandatory execution
binding policy, which the later migration intentionally relaxed. This change
does not rewrite that separate account-sync policy or weaken its tests to
declare the whole sweep green.

The rollout additionally applied all 69 migrations in the clean source commit
`6f6b80789a9ed54e132cf9da51f718a64c69dd37`, followed by the mouth-privilege
correction, to a new disposable PostgreSQL 17.6 instance. This reproduced
Supabase's direct default EXECUTE grants before applying the correction.
`150_runner_orchestrator`, `160_native_subscription_compute_identity`, and
`165_cloud_agent_public_mouth_privileges` pass with those grants present.
The read-only privilege assertions also pass against the production database.
The earlier 72-migration workspace sweep included unrelated draft migrations;
those drafts were not included in this deployment.

The new cloud probe ran in the existing Linux VM
`qorpera-6e0828bcb21c417f9d6e2ac33b63f2d2` as the unprivileged runner user with
shared GID 100 and umask 0007, against `/qorpera/company-live`:

```json
{
  "platform": "linux",
  "companyFileSha256": "212fb4ede5efcda5c73428a27218c30bccf01f7067b7b1a4e3668539544c045b",
  "publicMessages": 2,
  "immediateDelivery": true,
  "retryDeduplicated": true,
  "privateOutputExcluded": true
}
```

The probe uses the real host, process adapter, MCP transport and NAS filesystem,
with a deterministic faux harness and in-memory control-plane callback. The
database authority/idempotency tests run separately against real PostgreSQL.
It uses no real provider credentials or paid requests. It is not a claim that
the new production RPC, official model behavior, or all-clients-offline wake
dispatch has been deployed and accepted. The temporary NAS proof tree is
removed after validation; no existing company files are modified.

The reusable probe is
`packages/shell/test/fixtures/run-cloud-mouth-probe.ts`. Cloud images run
bundled JavaScript; bundle this entry with the repository's esbuild for
Node 22.19 and place `cloud-mouth-harness.cjs` beside the resulting module.
Pass the live company parent path as its first argument. Do not point a local
test runner at production credentials or replace a signed service with this
test bundle.

## Production activation

The old adapter and the new database guard are intentionally incompatible.
There is no compatibility path that turns ordinary provider output into chat.

1. Commit the scoped runtime changes and build a compatible signed runner image
   through the existing provenance pipeline. Do not bypass clean-source or
   signature gates.
2. Pause admission/dispatch and drain or explicitly resolve existing old-image
   runs. Do not invalidate a live conversation mid-turn.
3. Apply `20260827004000_cloud_agent_public_mouth.sql` through the normal
   migration process and activate the signed image containing the new host and
   runner adapter together. Resume dispatch only once both are ready.
4. Run an authorized production conversation: observe progress before process
   exit, one final send, the NAS change, canonical replay on another client,
   no raw provider text, and a completed durable run.
5. Repeat a transport-retry/cancellation check without replaying external work.
   Record the image, migration, run and event identities in this handoff.

### Activated 2026-08-27

Activation was explicitly approved. The runtime source is committed and pushed
on `codex/runtime-step1-cloud-mouth`:

- `6f6b80789a9ed54e132cf9da51f718a64c69dd37`: loop, mouth, native adapters,
  database guards, regressions and this handoff.
- `639e128e87f307131604839b9f3f508a0e694636`: explicit
  API-role EXECUTE revocation and its regression test.
  This is a database-only follow-up; it does not change the signed guest bytes.

| Production artifact | Identity |
| --- | --- |
| LXD guest image | `7f584f0c3bc2c47a4283ea98c42d658d8f5990142e07d65481f803e514a27c9c` |
| Guest manifest | `770ce4958423d52169c1290e3986d48c6c3f5924e856872f07738c8cd76b7774` |
| Signed provenance SHA-256 | `c24706bbbdcd2e3fa9eed05c8b9bcdc4b82b9271a5a89e32611036d2d123c916` |
| Clean-boot acceptance SHA-256 | `7d6844d54c6bae70df23b0a7c5bf5aec8ecab7262911d310d16eccb5730d10e4` |
| Activation script SHA-256 | `a3a0c0e99c043289e3e582a2dc254a1761a4fc4ecbdbffd55d63719b3131a753` |

The clean detached source passed `npm ci --ignore-scripts`, the full repository
check, the 81 focused tests, runner packaging and provider packaging. The
generated public model-data cache was validated before use; no dependency or
lockfile changes were needed.

Clean-boot acceptance ran at `2026-08-27T08:21:44Z` on `company41-node-01`.
It proved KVM/UEFI Secure Boot, fail-closed startup without job credentials,
and cross-service-identity read/write access to the live Company File mount.
The acceptance record intentionally identifies an unsigned candidate: that
exact immutable image and acceptance digest were signed afterwards with the
existing off-node provenance key. Local and on-node signature verification
passed. The private key and passphrase were not copied to the runner node.

The existing signed nested sandbox OCI image, NAS mount, host provider binary,
trust root and signing public key were reused. No Company File was re-seeded or
copied onto a replacement VM disk. The v45 package, acceptance record,
provenance and build/verification/activation scripts remain under
`/home/company41-admin/step2-lxd` on the node.

The dispatcher was stopped after verifying there were no active or queued
jobs. `20260827004000_cloud_agent_public_mouth.sql` was applied atomically and
registered in Supabase migration history, then the signed guest pins were
activated and the dispatcher restarted. A production permission audit found
direct API-role grants inherited from Supabase default privileges. The native
RPC's internal service-role check already rejected those callers; the
registered `20260827004500_cloud_agent_public_mouth_privileges.sql` follow-up
also removes their EXECUTE permission. Both send RPCs are service-only, clients
cannot mutate receipts, and trigger functions cannot be directly invoked by
API roles. Existing effect-time authority checks remain in place.

Both database guards are enabled. `qorpera-lxd-provider.service` and
`qorpera-runner-orchestrator.service` are active/running. No service remains
paused. No unrelated draft migration, desktop release or NAS-data deletion was
performed.

### Remaining production acceptance blocker

The released `/Applications/Qorpera Base.app` version `0.20.41` cannot open the
registered NAS-backed Company41 projection at
`/Users/jonas/Companies/company41-88227549`. It reports:

```text
Error invoking remote method 'company:open': Error: ENOTEMPTY: directory
not empty, rmdir '.../agents/14c35f74-ce03-40c4-aceb-c4b36be4fe29'
```

The source-level conflict is in `cloud-company-merge.ts`: tree reconciliation
uses `rmdir` on a removed logical directory, but `instructions.md` is excluded
from that tree by `cloud-company-snapshot.ts` and remains physically inside it.
The cloud roster confirms that this agent still exists with archived status.
Its instruction file is not disposable acceptance-test data. No existing
agent file was deleted or moved to bypass this failure, and no test prompt was
submitted to one of the similarly named temporary companies.

The send ledger is still empty. Therefore there is no v45 real-model run ID,
canonical public-send event, second-client replay result or NAS proof file to
claim as accepted. Repair the desktop projection/metadata reconciliation
boundary, then run the authorized production conversation and retry/cancel
checks above. Do not substitute a local model run, manufacture user admission
claims, or delete archived-agent data to obtain a passing screenshot.

## Remaining steps, not absent plumbing

Inbound tool-result fences and outbound effect policy are runtime step 2.
Five-kind wake policy, file-change wakes and complete offline dispatch are step
3. The governed Company File mutation gateway and its path-authority projections
still need integration. Shared persistent office desktops, workers/todos,
memory indexes, connectors, scheduler/listeners and final constitution follow
their specified order. The existing live NAS mount is not a reason to create a
parallel file store or move execution back onto a member's machine.
