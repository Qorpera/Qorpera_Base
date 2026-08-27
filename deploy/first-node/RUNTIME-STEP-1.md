# Runtime step 1: loop plus mouth

Date: 2026-08-27

Status: implemented in source and exercised in an isolated cloud runner probe.
Not yet activated in the production database or signed runner image.

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
native provider host. This verifies packaging, not image signing or deployment.

All 72 migrations apply to disposable PostgreSQL 17.6. The new send tests and
the affected runner/native suites pass. The complete SQL sweep passes 29 of 30
suites. `100_session_arbiter.test.sql` retains a pre-existing mismatch with the
2026-08-26 account-trail policy: it submits an invalid event schema while
expecting an authority error. It also asserts the earlier mandatory execution
binding policy, which the later migration intentionally relaxed. This change
does not rewrite that separate account-sync policy or weaken its tests to
declare the whole sweep green.

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

No production migration, service replacement, release, or commit was performed
for the isolated probe. Activation requires explicit commit/deployment approval.

## Remaining steps, not absent plumbing

Inbound tool-result fences and outbound effect policy are runtime step 2.
Five-kind wake policy, file-change wakes and complete offline dispatch are step
3. The governed Company File mutation gateway and its path-authority projections
still need integration. Shared persistent office desktops, workers/todos,
memory indexes, connectors, scheduler/listeners and final constitution follow
their specified order. The existing live NAS mount is not a reason to create a
parallel file store or move execution back onto a member's machine.
