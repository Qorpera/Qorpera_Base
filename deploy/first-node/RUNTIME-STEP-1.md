# Runtime step 1: loop plus mouth

Date: 2026-08-28

Historical acceptance status (2026-08-28): runtime step 1 is implemented and passes real connected-OpenAI cloud
acceptance: progress, final delivery, NAS writes, completion with the desktop
closed, read-only client replay, and stale-send rejection. The allowance block
is resolved. The macOS 0.20.44 client is published and installed through its
updater. Its actual Stop button cancels the exact cloud run, revokes that run's
native lease atomically, and returns the conversation to idle. The saved
connected account remains usable. The observed post-final completion delay
below remains a performance follow-up; this is not completion of later runtime
steps, full outage continuity, or Claude acceptance.

This dated evidence certifies only its recorded source, image, schema and
client bytes. The later Steps 0–2 integrated assembly, including organization,
governed paths, custody and executable/read provenance, is not accepted by
inheritance. Its source corrections and separate live gates are recorded in
[Steps 0–2 review corrections](RUNTIME-STEPS-0-2-REVIEW-CORRECTIONS.md).
Infrastructure state below is historical, not a current health assertion.

Account and company access no longer depend on model readiness or allowance.
Supabase recovered after the approved restart. The NAS port-change outage is
also recovered: an Active/Backup bond serves `192.168.0.90`, the existing NFS
mount is verified, and the cloud services are running. Neither recovery is a
claim of full cloud-control-plane outage continuity.

This is step 1 of the cloud runtime implementation order,
not the earlier infrastructure Step 1. The Company File is the live digital
company. All execution and message authority belong to the cloud. Desktop
clients submit intent and render canonical events; they do not run the mouth.

## Audit: what already exists

| Component | Evidence and disposition |
| --- | --- |
 Live Company File | `/mnt/qorpera-companies` is a writable NFS mount on `company41-node-01`. The company tree reaches a runner as `/qorpera/company-live` through virtiofs. Reused, not rebuilt. |
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

Run focused tests from `packages/runtime`:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/cloud-agent-mouth.test.ts test/cloud-native-provider-host.test.ts test/cloud-native-provider.test.ts test/cloud-runner-worker.test.ts test/cloud-runner-broker.test.ts test/cloud-runner-sandbox.test.ts test/official-codex-mouth.test.ts
```

The v47 activation focused suite passed 89 tests across these nine files. They exercise
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

The earlier 72-migration sweep applied to disposable PostgreSQL 17.6. The new send tests and
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
`packages/runtime/test/fixtures/run-cloud-mouth-probe.ts`. Cloud images run
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

### Desktop account-access repair and rollout, 0.20.43

[Desktop 0.20.43](https://github.com/Qorpera/Qorpera_Base_Releases/releases/tag/v0.20.43)
was published at `2026-08-27T20:42:25Z` from clean master commit
`fcaa01588a73dbe51ce0913d945feecb71c13d0d`, with source tag `shell-v0.20.43`.
It removes the model-readiness check from authenticated startup. Qorpera
authentication and company membership checks remain required; model connection,
quota and execution authority remain requirements for model work, not login.

The launcher paints before company listing completes, reports slow cloud
responses, retains existing cards during failed refreshes, and offers Retry
after a failed request. Failed opens, migrations and invitation acceptance
return control to the launcher. Gateway HTML becomes a readable cloud-service
error. Late list/bootstrap responses cannot restore a signed-out account's UI.

All 51 tests across `company-launcher`, `userland-wiring`, `account-auth` and
`renderer-smoke` pass, including exhausted, disconnected, failing and stalled
provider cases. The full repository check passes. An isolated Electron fixture
with networking blocked verifies loading, cloud-error presentation, successful
retry without another login, and recovery from a failed company open. It uses
synthetic account/company data and makes no model requests.

The normal installer build passes its packaged-renderer and runtime-file
checks. The release script verifies updater asset names, sizes and SHA-512
hashes. The app was installed through the existing updater, and strict
code-signature verification passes with the same Apple Development identity;
this is not a notarization claim. All four changed installed renderer assets
match the committed source byte-for-byte. Windows remains on its prior release.

The installed app retains the Qorpera session and displays the new loading and
slow-response states. No provider was reconnected, no credit was redeemed, and
no real inference was requested. The earlier live company-open failure was a
Supabase HTTP 522 response, not a model-allowance error. After installation,
the public-key Supabase auth health check still timed out after 15 seconds with
no response, and company listing remained pending. This release does not claim
to repair that separate backend outage or complete real cloud-mouth acceptance.

### Supabase recovery and independent NAS outage, 2026-08-27

The user approved restarting the affected Supabase project and starting a
separate cloud-resilience implementation task. One restart of
`wovsmjvghnbcbfazdtvr` (Qorpera Cloud Step 1) was accepted at
`2026-08-27T21:24:16.428Z`. No other project was restarted, and no reset,
restore, credential change, or billing action was performed.

At `2026-08-27T21:30:13.438Z`, detailed Database, Auth, REST, Storage, Pooler,
and Realtime health checks were all healthy. A Management API read-only
`select 1` returned HTTP 201. The installed desktop then displayed Company41's
staff roster and opened the existing Software Developer conversation. This
used the existing Qorpera login without reconnecting a model account, redeeming
credit, or requesting inference. These checks establish recovered company
access, not a successful fallback or real cloud-mouth acceptance.

Follow-up infrastructure checks found an independent NAS reachability failure:
the node's ping to `192.168.0.91` returned `Destination Host Unreachable`,
TCP 2049 returned `No route to host`, its neighbor entry was `INCOMPLETE`, and
the Mac also received no ping replies. A bounded stat of
`/mnt/qorpera-companies/company41/live` timed out. At this checkpoint the
configured NFS mount remained present, but that was not proof of available
live storage. The node's `qorpera-lxd-provider.service` was active. The initial
probe did not recheck the orchestrator guest. The later maintenance below used
the existing `/usr/sbin/lxc` allowlist and a user-authenticated sudo terminal;
no permissions were changed to bypass authentication.

No NAS or node restart, remount, company-data mutation, replacement store, or
model retry was attempted during those initial diagnostics. Only the diagnostic
process blocked on NFS was terminated. The separate resilience task owns bounded
storage/auth requests, immutable-object replication, and safe runner-outcome
recovery; none of that work is deployed yet. NAS loss and Supabase control-plane
loss remain distinct failure modes. A desktop cache or immutable replica cannot become a competing
writable Company File.

### NAS dual-port recovery, 2026-08-28 (Copenhagen)

The cable had moved from NAS LAN2 (`192.168.0.91`) to LAN1 (`192.168.0.90`),
while the node's hard NFS mount still targeted LAN2. Temporarily reconnecting
LAN2 restored the original mount. The user approved a controlled storage
maintenance window and then returned the single cable to LAN1.

Read-only database checks before and after pausing dispatch found no queued or
leased Company41 jobs. Nine running VMs with the live NAS device belonged to
completed or failed jobs with no remaining lease. They shut down gracefully
after LAN2 was reconnected, and the existing proof file's checksum matched.
The provider, Company Computer provider, and orchestrator were paused before
the normal unmount. No force-stop, forced/lazy unmount, soft NFS, or replacement
Company File was used.

DSM now has one DHCP `Bond 1` containing LAN1 and LAN2. Its saved mode was
independently re-opened and verified as **Active/Backup Mode**. With only LAN1
connected, the bond is connected at `192.168.0.90`; gateway and DNS remain
`192.168.0.1`. The NAS firewall was already disabled and unchanged, and no DHCP
Server package was installed. The NFS export remains
`/volume1/qorpera-companies`, restricted to node `192.168.0.206`.

Only the NAS address in the node's `/etc/fstab` changed from `.91` to `.90`.
The update checked the full pre-image, preserved root ownership and mode 0644,
and atomically installed the replacement. The prior file remains at
`/etc/fstab.qorpera-before-nas-bond-20260828`. A normal remount succeeded at
`/mnt/qorpera-companies`, using NFS 4.1, `rw,hard`, and the existing options.

The actual `qorpera-provider` service identity (UID 995, GID 983, groups 983
and 101) read the existing 39-byte `live-check-v44-20260826T204912Z.txt` from
the remounted Company41 tree. Its SHA-256 remained
`24c0e310ed3b1018eaa892031826aded7bafd0d3790c28573d83aea16c4e3fa2`.
The same identity created a uniquely named temporary probe, wrote and fsynced
it, read back identical bytes, and removed only that probe and its directory.
No existing company file was edited or deleted.

Both host providers resumed at `2026-08-27T22:50:05Z`; the orchestrator resumed
at `22:50:25Z`. All three were verified active/running. From the orchestrator
VM, the runner provider's HTTPS health check returned `{"ok":true}` using the
existing CA with certificate verification enabled. The Company Computer
provider's node-loopback health check also returned `{"ok":true}`. A final
read-only audit at `22:52:20Z` still found no queued or leased Company41 jobs.
The nine terminal-job VMs remain stopped with their disks retained; completed
or failed work was not replayed. No model request or credential change occurred.
Temporary maintenance scripts were removed, the sudo timestamp was invalidated,
and the task's dedicated terminal session was closed. The fstab backup remains.

This verifies live LAN1 storage and service recovery, not a physical LAN2
failover test. DHCP does not establish a permanently reserved address; router
reservation and a cable-swap acceptance test remain unverified. The separate
cloud-outage resilience implementation has not been deployed by this change.

### Current v47 activation and earlier allowance blocker

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
`packages/runtime/test/fixtures/run-official-codex-mouth-probe.ts`, not the library
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

At that checkpoint, restored NAS access was insufficient: provider allowance
still blocked real acceptance. The following authorized tests supersede that
blocker without changing the provider account, billing, or signed v47 image.

### Real GPT cloud acceptance, 2026-08-28 (Copenhagen)

The user confirmed restored allowance and authorized full testing through the
existing GPT connection. Three fresh prompts were submitted through the
installed Company41 Software Developer conversation. No admission record was
manufactured, no model account was changed, and no reset credit was used. The
native provider remains `openai` / `codex-cli`, with `provider-default` model
selection and explicitly low effort; the desktop model label alone is not
evidence of the exact model used by the native subscription.

All timestamps below are UTC on 2026-08-27. The runs share profile
`88227549-9724-43c2-8966-9fafb3e855d6`, staff
`b5052ad5-97cb-45e1-9da7-9c413da69530`, and session
`14ea9baa-ecab-4f20-b905-f473d433d037`.

| Run | Canonical sends | Durable outcome |
| --- | --- | --- |
| `eac6b2bd-185b-46da-96a0-b4458adebfe0` | Progress 23:03:14.626460, sequence 57; final 23:04:35.581579, sequence 58 | Completed 23:07:45.330115; attempt 1; native lease released |
| `00a2409a-7068-422b-b9a5-0e9a2612a756` | Progress 23:14:40.937279, sequence 60; final 23:15:49.761106, sequence 61 | Completed 23:18:54.329593; attempt 1; native lease released |
| `34cad3d0-3872-47e4-be00-47fd4af17866` | Progress 23:43:07.003449, sequence 63; no final | Cancelled 23:43:38.274579; attempt 1; native lease revoked after the cleanup correction below |

The first run created only `runtime-step1-v47-live-20260828-01.txt` in the
live Company File. Its 44 bytes hash to
`ddc691f88582dd0f2a8ee7df4a28eb835063e5882163d5d59721c0df139a5176`.
The second created only `runtime-step1-v47-offline-20260828-02.txt`; its 47
bytes hash to
`022a32cd42424bdc90f175d86d4cebab434ea98c779652363eedd5a45d394b3b`.
Both hashes were read from `/mnt/qorpera-companies/company41/live` on the
cloud node. These explicitly named acceptance files remain as evidence; no
existing agent or business file was removed to make the tests pass.

The second run continued with the desktop closed. The definitive quit was at
23:15:20; process checks confirmed the app absent at 23:15:26, before the final
send, and again after completion. The app was reopened at 23:20:27. Its
conversation then showed each progress/final once. The cloud—not a local model
process—performed the file write, public delivery, and completion. This proves
an admitted turn survives all desktop clients being closed, not the later
five-kind wake/scheduler architecture.

While the first run was live, two identical progress-send retries returned its
original event `862fea44-4635-46d3-893a-fab60c5a2117` at sequence 57. There
were still exactly two sends after completion. An exact retry after each
completed run was denied with SQLSTATE `42501`, without adding a message or
incrementing the attempt count. The tool-output canary was absent from all
assistant messages; its intentional occurrence in the human test prompt is
not counted as an output leak. Public assistant entries contain only the
explicitly sent text, not provider stdout or ordinary final output.

At 23:54:43 a fresh, independent read-only client used the production
`QorperaHostedPrimary` parser and `CloudTrailSynchronizer` with the existing
member session. It downloaded and materialized all 63 canonical events with
zero quarantine entries, uploads, or session creations. All five acceptance
messages matched their exact event IDs, text hashes, and run provenance.
Restarting that client from its saved cursor downloaded/materialized zero
additional entries. Its transport allowed only read RPCs; it made four reads,
zero mutation attempts, and started no model process. The temporary projection
was removed afterwards. This is a second client projection, not a claim of a
second separately installed desktop or another human's credentials.

Two performance observations remain: native harness execution took 98,333 ms
and 81,538 ms, respectively, while durable job completion followed the final
send by approximately 190 and 185 seconds. That lag is after the native harness,
not missing message delivery. Its exact publication/cleanup cause is not yet
established and should not be described as model latency.

### Exact-run Stop and native-lease correction

The installed 0.20.43 cloud-session `abort` handler explicitly returned "not
wired yet". Historical failure alerts could also mask active-run state. The
new desktop source polls an independent exact-session control projection and
shows Stop for the displayed run only. It sends the session/run identity to a
member-authenticated RPC, disables duplicate pending clicks, reports uncertain
responses without claiming success, and rejects stale polling results after
cancellation or a conversation switch. It neither kills a local model nor
manufactures assistant output.

Migration `20260828002000_cloud_session_run_control.sql` was applied atomically
and registered in production at approximately 23:40:35, with SHA-256
`dbb75cff3cf29942c3f787880808aa0d797415ea47e226beaec8cbab31a7b248`.
Read/control RPCs bind the company, staff, session, and run. Cancellation
rechecks and locks current membership; the caller must retain write access and
be the run creator or a company owner/admin. The existing job cancellation
endpoint receives the same check. Retrying a terminal run returns its terminal
state without touching a successor. No unrelated migration was pushed.

The third GPT test sent progress, then waited for 90 seconds without changing
files or external data. The new API cancelled that exact run using the existing
desktop member session; its repeated receipt remained `cancelled`, the session
control projection became idle, and there was one cancellation audit record.
The provider and sleep processes stopped. No final appeared after the wait
deadline. This tests the real cloud API, not the as-yet-unreleased Stop button.
After verification, only this test's recovery card was dismissed through the
installed app's Discard action. That records a recovery decision without
deleting its prompt, progress message, job, or audit history; it does not retry
the work. Other historical failure alerts were left unchanged.

That test exposed a cleanup ordering defect: native lease release required a
live job, but cancellation had already revoked the job. Its stale active row
could occupy connected-account concurrency until expiry. Migration
`20260828003000_terminal_native_lease_cleanup.sql` makes the job's terminal
transaction close only its run-scoped native leases. Completed jobs release
them; failed/cancelled jobs revoke them. It does not revoke saved credentials,
the connection, or the Compute Identity, and it does not weaken send authority.

The cleanup migration was applied atomically at 23:52:46.549, with SHA-256
`12594bb33260ac1f09abd915786a3d1608ad6dfc9a47ac04e691da1522994516`.
Its reconciliation affected the one stale lease belonging to the cancelled
acceptance run; preflight found no active leases for running jobs. Afterwards
there were no stale terminal-job leases. At 23:54:13 an exact send retry from
that revoked run was denied with `42501`: still one public progress message,
no final, and attempt count 1. Fresh cancellation/completion/failure transition
coverage is in isolated PostgreSQL. The installed-Stop acceptance closing the
rollout gate is recorded below.

The added controls/renderer/auth suites pass 35 tests across three files. The
six existing mouth, delivery, native host/adapter, official-CLI, and broker
suites pass another 54 tests, for 89 focused tests in this continuation. These
are distinct from the earlier v47 nine-file test selection. `npm run check`
passes. All 74 migrations in the continuation worktree apply to disposable
PostgreSQL 17.6; SQL suites 165 and 280 pass, including membership revocation,
cross-session rejection, terminal retries, unchanged successor runs, and
native-lease cleanup for cancellation, completion, and failure. The completion
fixture must make a real database final send first; the final-send guard is
not disabled. The earlier full SQL sweep's known suite-100 mismatch is not
reclassified as passing.

### Desktop 0.20.44 release and installed Stop acceptance

The user approved committing, publishing, installing, and testing this update.
Commit `426e996932d3d6b49e94e5552e116efae25d1450` was pushed to `master` and
claimed by source tag `shell-v0.20.44`. The release was built from that exact
clean revision. `npm run check` passed, as did 163 focused tests across 14
shell suites. No dependency or lockfile changes were made.

The normal publisher created
[v0.20.44](https://github.com/Qorpera/Qorpera_Base_Releases/releases/tag/v0.20.44)
at `2026-08-28T00:10:13Z`, without bypassing its clean-source, version, spacing,
or claim checks. All five macOS assets were uploaded under the updater's exact
filenames, with manifest size and SHA-512 verification. The ARM64 ZIP is
278,207,344 bytes with SHA-512
`FYU7DHse6eowHrMUI/e7t/I7RNOlllbxN1oxggTwYAO34lJoxIx6mmOECqzHRpHf0ROXZCrMXEDtvOduNySz7A==`.
Windows remains on its prior release; this was the explicit macOS-only lane.

The app was installed through its own Check again / Restart to update
controls. The first checks still reported 0.20.43 as current; after a normal
app restart, the updater discovered and downloaded 0.20.44. No installed files
or updater settings were patched to force the installation. The installed
launcher and bundle both report 0.20.44. Deep, strict code-signature verification
passes for both the packed and installed app, with Team ID `U472A89YFG` and
the existing Apple Development identity. This is not a notarization claim.

Installed file hashes exactly match the built artifacts:

| Installed module | SHA-256 |
| --- | --- |
| `dist/cloud-session-run-control.js` | `036c6e2b727bba292f6fdc09b9ab17db692744d4d7cdd2334e5decb59136d4dd` |
| `dist/main.js` | `4b6ecb56214f6f3d650fdd721d0613d9069c467698ef262f0b28579c004088fc` |
| `dist/userland/renderer.js` | `1fd33674fa929cb8c42f3cbd7de039a973dc9612260b96878173394ce3c3b02e` |

A fourth bounded GPT prompt was submitted in the installed Software Developer
conversation, with marker `RUNTIME_STEP1_V47_STOP_02044_20260828_04`. It requested
one progress send and a 90-second wait, with no file, agent, routine, setting,
or external-data changes. All following timestamps are UTC on 2026-08-28.

- Run `4e6d80c2-a555-40ce-b017-fd426fd28b70`, job
  `b11d143c-fc6c-49be-8820-85beeda45df2`, admitted at 00:13:39.473462;
  the runner started at 00:13:56.827822, attempt 1.
- Progress event `2917cd2e-5a18-401e-9031-ee432e1bfefe` committed at
  00:14:13.734794, sequence 65. Its text SHA-256 is
  `220bcef4b3877d1bd13c8f34f09422446784fbf29a505e694c80cee4205d4400`.
  The installed conversation showed that progress and an enabled Stop button.
- Clicking the actual conversation Stop button cancelled the run at
  00:14:27.401714. Native lease `850c89eb-4e55-4056-bf76-7e8abe9ff738`
  became `revoked` at exactly the same transaction timestamp. There was one
  cancellation audit receipt and no additional execution attempt.
- The control disabled while its request was pending, then the working state
  and Stop button disappeared. The post-cancellation guest process check
  found neither the provider nor its waiting process. An exact stale send was
  rejected with SQLSTATE `42501`; there was still only one public progress event.
- At 00:15:55, after the full 90-second wait window, the run remained cancelled
  with no final send, no retry, and no reactivated lease. Only this test's
  recovery card was dismissed using Discard; its prompt, progress, job, and
  audit history remain. No external work was replayed.

A fifth, final-only GPT turn then verified reuse of the same saved connection
without reconnecting the account or waiting for the cancelled lease to expire.
Its marker was `RUNTIME_STEP1_V47_REUSE_02044_20260828_05`; it requested no
Company File or external-data changes.

- Run `94dac94a-9e4f-4782-ac60-f1aae685f4f8`, job
  `58af94ba-a43b-42f9-96c6-3cd61f39210e`, admitted at 00:15:34.938579
  and started at 00:15:51.749311, attempt 1.
- Final event `7cad0676-9248-46c6-9fb8-c412386d011c` committed at
  00:16:04.764878, sequence 67. Its exact requested text appeared once in
  the installed conversation, with SHA-256
  `19d2031e97a4ad8cb06e2a73e0b381f046f50bea2b45e5f7a934f7e95a7aa8a5`.
- The job completed at 00:19:25.278427 with a closed
  `qorpera.native-harness-result/v2` result. Native lease
  `5969c594-cede-4655-8e62-9570514dd0fe` was released, and the installed
  conversation returned to idle. An exact post-completion send was denied
  with `42501`, still with one final message and one execution attempt.

The native harness took 15,044 ms, while durable completion followed the final
send by about 200.5 seconds. This independently reproduces the post-final
performance issue above. The completion status is not being made optimistic
to conceal that delay; reducing it remains a separate follow-up.

The Stop and subsequent connection-reuse guests both report the signed v47
base-image fingerprint
`094804d51aac3a35512009a059a43b9e220aaf47837e825594dd144b133ff242`.
The live NAS-backed Company File was reused. Neither a local model process nor
a synthetic database admission stood in for the product path. The separate
outage-resilience worktree has not been merged or deployed here.

## Remaining steps, not absent plumbing

Inbound tool-result fences, outbound effect policy, governed Company File
paths and cloud secret custody have later Step 2 source/component evidence;
they are not absent plumbing. The current integrated assembly still requires
coordinated production activation and exact signed acceptance, including the
new executable/read-provenance pins. The organization-aware bootstrap worker,
not a legacy direct gateway call, owns cutover.

Five-kind wake policy, file-change wakes and complete offline dispatch remain
Step 3 and are not incorporated here. Shared persistent office desktops,
workers/todos, memory indexes, connectors, scheduler/listeners and the final
constitution follow their specified order. No client or raw NAS mount may
stand in for the governed cloud execution path.

## 2026-09-02: typed usage-limit signal and member notification

The 2026-09-01 contract amendment places the typed usage-limit signal from
provider adapters and the member notification in Order 1 (section 17,
section 19 amendment placement). Source implementation and verification are
recorded in the
[Steps 0–2 amendment ratification record](RUNTIME-STEPS-0-2-AMENDMENT-RATIFICATION.md):
migration `20260828019980_provider_usage_signals.sql`, the host's
`nativeProviderUsageSignal` mapping from safe failure categories, and the
runtime's recording of the signal against the run's exact sponsor and
connection version before the job fails. The desktop surface that renders
member notifications is a client follow-up; the durable record and its
member-scoped read/acknowledge RPCs are the control-plane deliverable.
Automatic sponsor handoff remains Order 3. This is source evidence, not a
signed or deployed acceptance claim.
