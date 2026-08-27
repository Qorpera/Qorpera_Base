# Runtime step 1: loop plus mouth

Date: 2026-08-27

Status: implemented and deployed to the production database and signed v47
runner image. Desktop 0.20.42 is installed and opens Company41. Real-provider
acceptance is blocked by the connected OpenAI provider's allowance/quota;
the latest run delivered no public message. Step 1 is not yet accepted.

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
node ../../node_modules/vitest/dist/cli.js --run test/cloud-agent-mouth.test.ts test/cloud-agent-mouth-delivery.test.ts test/cloud-native-provider-host.test.ts test/cloud-native-provider.test.ts test/cloud-trail-sync.test.ts test/cloud-runner-worker.test.ts test/cloud-runner-broker.test.ts test/cloud-runner-sandbox.test.ts test/official-codex-mouth.test.ts
```

The current focused suite passes 89 tests across these nine files. They exercise
private-output canaries, immediate sends, lost-response
replay, transport authentication, malformed arguments/receipts, cancellation,
final-delivery obligations, silent no-audience jobs, provider process contracts,
and canonical replay on two read-only clients. Client replay requires no local
model process and makes no authoritative message writes.

`npm run check` passes, including formatting, lint, types, pinned dependencies,
cloud boundaries, lockfile checks and browser smoke checks. No dependencies or
provider keys were added.

The production runner packaging script also passes, including the bundled
native provider host. The signed v47 image was built and activated from clean
source, as recorded below.

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

### Initial v45 activation, 2026-08-27

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

Both database guards are enabled. That initial cut did not include a desktop
release, unrelated draft migrations, or NAS-data deletion. The later client
rollout and current runner activation are recorded below.

### Desktop projection repair and rollout, 0.20.42

The earlier `/Applications/Qorpera Base.app` version `0.20.41` could not open the
registered NAS-backed Company41 projection at
`/Users/jonas/Companies/company41-88227549`. It reported:

```text
Error invoking remote method 'company:open': Error: ENOTEMPTY: directory
not empty, rmdir '.../agents/14c35f74-ce03-40c4-aceb-c4b36be4fe29'
```

The source-level conflict was in `cloud-company-merge.ts`: tree reconciliation
used `rmdir` on a removed logical directory, but `instructions.md` is excluded
from that tree by `cloud-company-snapshot.ts` and remains physically inside it.
The cloud roster confirms that this agent still exists with archived status.
Its instruction file is not disposable acceptance-test data. No existing
agent file was deleted or moved to bypass this failure, and no test prompt was
submitted to one of the similarly named temporary companies.

Commit `18181de7f2698c9f44347a7ee141eebead84bc35` repairs snapshot merging,
cache reconciliation and reviewed replacement. Before installing an updated
logical tree, reconciliation retains the directory entries needed to hold
omitted, separately managed files or subtrees. It does not read, move, delete
or publish those omitted contents. A directory-to-file replacement that would
destroy such data is rejected. Ordinary logical deletions still apply, and
subsequent reconciliation is a no-op.

Four regressions reproduce the original failure and cover nested omitted
directories, retained staff instructions, ordinary deletion and incompatible
file replacement. All 12 merge tests and all 64 tests across the eight affected
Company File/sync suites pass. The archived agent directory was copied to a
private temporary backup before client rollout; its instructions and memory
were not edited.

The integrated desktop source passes `npm run check` and all 612 shell tests.
Release verification also removed fixed-delay assumptions from the session
startup and HTTP-upload test harnesses without changing production behavior.
The broad credential-isolated `./test.sh` run is not wholly green: an unchanged
`agent-session-auto-compaction-queue.test.ts` setup hook timed out under the
full run; all six tests pass when that file is rerun alone. This is recorded
separately from the focused cloud acceptance.

[Desktop 0.20.42](https://github.com/Qorpera/Qorpera_Base_Releases/releases/tag/v0.20.42)
was published and installed through the app's updater. Its source version
commit is `689c99ffbc85c46a698baff20f64d3d8ec9adff4`. Company41 now opens, and
real acceptance prompts below were submitted through that installed app.
The built and installed app pass strict code-signature verification. This
uses the existing Apple Development signing lane; it is not a notarization
claim.

The archived agent's instructions remain unchanged. Its local memory file,
absent from the canonical cloud tree, was removed by normal reconciliation
after the update; the original remains in the private backup at
`/tmp/qorpera-step1-client-release.JLmEex/archived-agent-before-update`.
No archived NAS agent data was deleted to make the app open.

### Current v47 activation and acceptance blocker

Two follow-up fixes are committed and pushed to master:

- `4d0f6b4eb0af8aa015744be6680258069a59224b`: atomic cloud cancellation,
  redacted native startup diagnostics, and the real official-CLI probe.
- `0fff8f62186d2b5532421595af6d243b69f05199`: retain refreshed native
  credentials after failed turns, with live authority validation before
  upload, and distinguish provider allowance/context/capacity failures.

Migration `20260827005000_cloud_runner_cancellation.sql` is applied and
registered in production. The earlier terminalizer set `finished_at` on a
cancelled job before recording its cancelling actor, violating the existing
constraints. Cancellation now writes consistent status, actor, and timestamp
atomically. The private helper is service-only; member cancellation still
uses the existing authorized RPC. Disposable PostgreSQL tests cover queued
and leased cancellation, authorization, idempotency, revoked-send rejection,
and Supabase default EXECUTE grants.

The credential fix persists only the paths present in the original capsule.
Provider sessions and private output are not added to the capsule. A failed
turn can retain a rotated login token; a cancelled or revoked execution cannot
upload it. Tests cover failure, missing final send, revocation, and cancellation.
This is an independently verified lifecycle defect, not a claim that it caused
the observed allowance rejection.

| Current production artifact | Identity |
| --- | --- |
| Guest source commit | `0fff8f62186d2b5532421595af6d243b69f05199` |
| LXD v47 image | `094804d51aac3a35512009a059a43b9e220aaf47837e825594dd144b133ff242` |
| Guest manifest | `daf2e4779aec0ed3eeb1b6d11ed3e1aff29c57f31e348755cf68ef8e716e6fec` |
| Signed provenance SHA-256 | `0411abde664dda56efd124c8e30dcef41e11c314afe8c47eeb46830e7f379833` |
| Clean-boot acceptance SHA-256 | `0c4ebe62d6b81a43b4955b63cf8147ddccca2f04a6f2883cc7c408666c198e72` |
| Activation script SHA-256 | `871971b0645143f08ca361ee60b09bf1de72da6d87aa0f84d241ebd7e6c6b3af` |
| Official-CLI probe SHA-256 | `653f903b43dbc2478acf1dba5664447b8b4726c1b68db936977ab9bfbd5f6464` |

Clean-boot acceptance completed at `2026-08-27T10:47:55Z`. It proved the
existing KVM/Secure Boot boundary, credential-free fail-closed startup,
cross-service mounted-file access, and the actual Codex 0.147.0 CLI's MCP
transport under the native service's hardening. The CLI used a scripted
loopback provider and no real credentials. Its explicit proof was:

```json
{"platform":"linux","publicMessages":2,"immediateDelivery":true,"retryDeduplicated":true,"privateOutputExcluded":true}
```

The first v47 probe bundle accidentally exported the fixture without invoking
it. That empty-success result was rejected before signing or activation. The
corrected verifier requires the exact proof fields, and the candidate was
booted and verified again. The digest above refers to that second, valid
acceptance record. Use the executable entry point
`packages/shell/test/fixtures/run-official-codex-mouth-probe.ts`, not the library
fixture alone, when bundling future probes. Pass the installed Codex command
as its first argument; the cloud probe uses `/usr/local/bin/codex`. Its
standalone regression requires a nonempty, exact proof object.

Both job-drain checks were empty before activation. The signature was verified
off-node and on-node with the existing trust root, then the provider pins were
updated and dispatch restarted. Both cloud services are active; no service is
left paused. The signed nested OCI image, NAS mount, host provider binary, and
credential custody are unchanged. Deployment evidence remains in
`/tmp/qorpera-runtime-step1-v47.mZyN4Q` and `/home/company41-admin/step2-lxd`.

| Real app-submitted run | Result |
| --- | --- |
| v45 `0df48cac-9d16-4d62-a3e4-2270ed760669` | Provider network failure; no public send. |
| v45 `a5c6cc96-ff31-45a7-a5ad-6361207195e4` | Provider exited before delivery; older diagnostic was unclassified. |
| v46 `de24dff0-7b80-48ed-beb6-c274bfd6199d` | Provider exited after MCP initialization; no public send. |
| v47 `12957817-d199-4e08-a6f6-e8ee55065697` | Provider allowance unavailable after MCP initialization; no public send. |
| v47 retry `ff2f8b31-718e-493b-a825-06b36fb0be99` | Same provider allowance rejection; no public send or NAS proof file. |

The v47 job is `5f172aeb-ed74-467e-9cdb-bc2bb8ab0ba4`, admitted through the
installed app at `2026-08-27T10:50:43.858648Z`. The native host recorded:

```text
Provider harness exited with 1 (provider allowance unavailable) [mouth=ready]
```

It used the existing OpenAI native subscription and `provider-default` model;
reasoning effort remains low. This closed diagnostic identifies an
allowance/quota rejection, not its exact reset time or billing remedy. No raw
provider error, credential, or private model output was logged to diagnose it.
The failed test was terminalized through the existing scoped operator helper
and audit path at `2026-08-27T10:52:45.850195Z`; no member identity was forged.
The send count is zero and `runtime-step1-v47-check.txt` is absent from the NAS.
No billing setting, reset credit, account, or provider was changed.

One fresh retry was submitted through the installed app at
`2026-08-27T14:38:33.155497Z`, using the unchanged v47 runtime and connected
OpenAI account. Its job is `d5ad6aa8-2f48-4d73-aaa1-579583ec1d55`.
The native service started at `14:38:47Z` and reported the same allowance
diagnostic with `[mouth=ready]` at `14:39:01Z`. The app displayed the failure;
there was no committed progress or final message. The expected
`runtime-step1-v47-retry.txt` is absent from the live NAS tree.

The scoped operator helper closed only this failed acceptance retry at
`2026-08-27T14:39:45.336013Z`, with a matching audit event. Verification found
zero active native leases for this run and zero queued or leased Company41
jobs. The dispatcher remains active. The receipt-replay check was not run,
because no real send exists to replay. This retry did not change billing,
reset credits, account selection, model selection, or deployment.

Restore the connected provider's allowance, then finish real acceptance:
progress before exit, one final receipt, NAS file contents, second-client
replay, and transport-retry/cancellation checks. The prepared replay check has
not been run because there is no committed production send to replay. Do not
substitute the scripted provider proof for this acceptance, manufacture human
admission claims, or call this step complete yet.

## Remaining steps, not absent plumbing

Inbound tool-result fences and outbound effect policy are runtime step 2.
Five-kind wake policy, file-change wakes and complete offline dispatch are step
3. The governed Company File mutation gateway and its path-authority projections
still need integration. Shared persistent office desktops, workers/todos,
memory indexes, connectors, scheduler/listeners and final constitution follow
their specified order. The existing live NAS mount is not a reason to create a
parallel file store or move execution back onto a member's machine.
