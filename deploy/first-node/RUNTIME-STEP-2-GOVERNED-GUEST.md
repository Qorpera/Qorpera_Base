# Runtime Step 2: governed Company File and native guest

Date: 2026-08-28. Status: source implementation and component verification.
**Not deployed; Step 2 is not complete.** This record supersedes the initial
native-boundary inventory where it describes later implementation. It does
not supersede the runtime architecture or authorize a production cutover.

## Non-negotiable ownership

Qorpera is pure cloud. Member devices submit requests and display results;
they do not execute agents, own wake delivery, or keep routines running. The
Company File is one live, company-owned digital firm. Agents work by changing
that state, not by creating a competing transcript-memory database or a private
company checkout. The shared Company Computer is a workbench over that firm,
not its only durable storage. Repositories may have isolated coding branches;
the company itself does not require a user-facing branch/commit workflow.

The governed path gateway uses the existing immutable objects and canonical
Company File head. A successful edit publishes one new live state atomically.
Internal revision ancestry is an operations/history mechanism, not a second
company, model-owned checkout, or promise of automatic semantic merging.

## Implemented source boundary

### Live path authority and effects

`20260828005000_company_file_path_gateway.sql` and
`cloud-company-path-{control,gateway}.ts` implement:

- Canonical logical paths and opaque path versions, including tombstones to
  prevent delete/recreate ABA. Invalid Unicode, path aliases, traversal and
  case collisions fail closed.
- Current human membership and permission **and** an explicit active agent
  grant. Subscription sponsorship is not a file permission. The current agent
  audience is company-shared; even a requesting owner cannot route private
  member material through that conversation.
- Hard denial of credential/secret paths and generic edits to operational
  projections. Protected writes and deletes produce proposals, not changes.
- Exact human approval of the immutable proposal digest, bounded to ten
  minutes and one application, with current path/resource versions rechecked.
  Skip, dismissal, rejection and expiry do not authorize application. Approval
  does not revive the proposing run or any expired lease.
- Verified immutable content plus one database transaction for head, path
  version, revision, receipt, reachability and the existing substrate
  projection. A permission check followed by an ungoverned NFS write is not
  represented as an atomic effect.
- Durable per-run read sets, bounded to 128 paths, revalidated before model
  requests, later effects and public sends. Cached bytes and receipts do not
  extend permission after revocation.
- A bounded retry only for the dedicated head-conflict response. A stale path
  version, unknown completion, timeout or ambiguous operation is not retried
  as fresh work.

Enrollment requires a verified existing head, owner/admin authorization and a
quiescent company. It is one-way in this implementation. Governed head guards
deny resets, disabling the gateway, and old whole-head publication. Legacy raw
object routes and Storage RLS access are denied for governed company content;
they must not remain a bypass around path permissions.

The human descriptor/list/ACL/proposal-review RPCs now have an exact-version
immutable-byte route (`20260828011000_member_company_path_objects.sql`, gateway
`member-company-objects.ts`). It derives the human/company from a member JWT,
checks current path authority and verified file membership before and after
storage I/O, and never accepts a raw-hash or offline capability. The bounded
`CloudMemberCompanyFileReader` rechecks the descriptor after assembling the file;
token acquisition, bodies and the complete read share one deadline. Neither
the route nor reader requires a model connection or available model quota.

This does not yet replace the product's whole-company materialization flow.
Human UI read/direct-edit integration and application of approved proposals
remain required before enrollment. The trusted proposal-application function
exists; a reviewed UI/executor path has not yet been wired.
**Do not enable Company41 to discover this at runtime.**

### Cloud-owned context and objects

`20260828006000_native_company_context.sql` and
`cloud-native-company-context.ts` assemble company/agent identity, job
specification, current canonical inputs, recent history, coworker descriptors
and the observed time from admitted cloud state. They distinguish current
human requests, private startup cues, history, job specifications and wake
data. Content cannot create a new role or grant authority merely by looking
like an instruction. Bounded excerpts retain hashes, attribution and explicit
truncation; `read_context` only reads an already admitted source at its exact
hash. Attachments are metadata until an authorized retrieval tool reads them.

The short runtime prefix states pure-cloud ownership, the live Company File,
the separate shared computer, explicit public delivery, path permissions and
proposal semantics. The runtime advertises only implemented tools. It does
not pretend that memory skills, computer control, hiring, routines, rooms or
coworker messaging are available because a prompt mentions them.

`20260828008000_native_company_object_staging.sql`,
`cloud-native-company-objects.ts` and gateway `native-objects.ts` implement
exact-object native reads/staging. The trusted host holds the independent
gateway credential; the harness does not. Each bounded object request binds
the current run and exact hash/size, with authorization before and after
transport. Staging bytes is not a canonical Company File mutation.

### Execution, public delivery and recovery

`CloudNativeCompanyRuntime` composes the native result fence, path gateway,
cloud context and existing public mouth. The native process has a private
scratch directory, an auth-only restored identity and no canonical company
mount. Ordinary assistant output, reasoning and diagnostics remain private.
Only authorized `send_message` receipts enter the public transcript.

`20260828010000_native_company_execution_admission.sql` admits one durable
native start per run after configuration/artifact verification and before the
thread or provider prewarm starts. Losing the admission acknowledgement does
not permit a second start. `20260828009000_company_path_runner_completion.sql`
binds completion to that start, the native binary digest, live run authority,
current path reads and valid effect/send receipts. Completion metadata is
server-derived; a worker cannot replace the whole head with an output tree.

The worker retains started, completed, failed and recovery records on private
persistent storage. An independent deadline ends execution even if renewal
stalls. Expiry or credential repair does not erase private outcomes, publish
them, or restore authority. Ambiguously started work is quarantined for
reconciliation and never automatically rerun. Node/volume loss and operator
reconciliation remain operational acceptance gates.

### Opt-in guest and package

The source adds `QORPERA_NATIVE_RUNTIME=company-path-v1`. Absence keeps the
existing lane; the new mode is not a fallback after a governed failure. It
requires the complete reviewed configuration:

- `QORPERA_NATIVE_CODEX_FENCE_PATH` and `QORPERA_NATIVE_CODEX_FENCE_SHA256`;
- `QORPERA_NATIVE_OBJECT_GATEWAY_URL`;
- private `QORPERA_LXD_NATIVE_OBJECT_TOKEN_FILE`, not a direct environment token;
- `QORPERA_LXD_COMPANY_NETWORK`;
- `QORPERA_LXD_RECOVERY_VOLUME_PREFIX` and `QORPERA_LXD_RECOVERY_VOLUME_SIZE`.

The provider checks the fully expanded LXD configuration and devices before
boot and again before assignment. Only the exact root disk, native identity
volume, per-run recovery volume and approved NIC are accepted. Unexpected
inherited mounts/configuration, changed image/binary pins and identity drift
fail closed. A lost recovery volume after execution starts cannot silently
be replaced with an empty disk. Volumes are retained, not automatically
deleted when the VM stops.

The closed `qorpera.lxd-company-runner-bootstrap/v1` contract binds those same
identities. Guest bootstrap checks root/identity/recovery mount separation,
rejects nested foreign network filesystems, verifies executable ownership and
digest, and fsyncs an exact recovery marker. An unmarked nonempty recovery
volume requires reconciliation. The separate `qorpera-company-runner` and
`qorpera-native-company-host` services use separate accounts and restricted
filesystem views; the native host and its Codex child still share an account.
Do not infer full secret/process containment from the unit settings alone.

Packaging accepts only the exact downstream source/patch contract and a
release-profile `x86_64-unknown-linux-gnu` artifact with matching size/hash,
compiler, pinned-toolchain debug-stripping record and upstream LICENSE/NOTICE.
The actual release binary passed the expanded cloud-node fixture, export
verification and contract-only guest packaging. The signed image was not
included or accepted by this checkpoint. Packaging rejects links and output/source
overlap. An artifact manifest is not signed image provenance or a complete
runtime-bundle admission pin. The installed production image/provider lane
has not been changed by this work.

### Transport and outage boundary

The gateway integrates the side task's durable immutable replication,
reconciliation, cleanup fencing, bounded NAS operations and dependency health.
Auth/API/Storage calls refuse redirects, bound successful bodies, cancel
unneeded bodies and preserve denial responses even when a body stalls.
The native host and provider similarly bound control calls and credential
delivery. Fixed errors do not expose raw backend pages or credentials.
Ordinary live object reads also recheck permission after storage I/O. A live
request that loses authority does not silently become an offline/delegated read.

This is component resilience, not a replacement authoritative control plane.
API/database authority loss still pauses admission and canonical effects.
The independently revocable exact-object offline read delegation remains
default-off and is **not authorized for activation**. Client-side Auth and
object-transport changes from the separate outage task are not imported here.

## Step 3 integration contract

The approved handoff is pinned to base
`a0b692947d5c867353591b36172afcc997f0521e` plus the 106-file source manifest and
patch SHA-256
`1d92d0aef8f5a9028cb3752ef97adf1ba828dee637c795d3004fa17a7f71461d`.
That frozen development handoff is not a release or a deployment approval.

| Identity | Meaning |
| --- | --- |
| `snapshot_id` | Durable Company File change/event identity. |
| `parent_snapshot_id` | Previous live head; governed publication has one successor. |
| `run_id` | Source run and server-owned wake ancestry anchor. |
| `receipt_id` | Existing durable operation receipt, not a new event queue. |
| `change.plan.path`, `change.version` | Changed logical path and resulting opaque version. |

Enrollment may establish a baseline head without a path revision; its first
governed child still names that head as its parent. No governed operation
resets the chain. Proposed-only changes create no revision/event.

The approved consumer follows that exact parent chain from a private
per-listener-version activation/processed head. It admits future commits only,
uses bounded candidate work, and advances the cursor, terminal delivery claim
and existing wake occurrence in one transaction. Gaps/ambiguous successors
fail closed. Denied paths and timing metadata remain private. Event identity
does not grant read permission: requester and recipient are checked before
admission and again at materialization/context/effect/send boundaries, with
event paths registered in the existing run read set. Agent messages and file
events share server-derived ancestry/hop guards.

The planned service-only `qorpera_runtime_wake_policy(run_id)` returns a closed
`qorpera.wake-policy/v1` object derived from admitted state, not payload flags.
The native/mouth/completion owner integrates required acknowledgements,
allowed silence and send limits only when that contract exists. Until then,
the current final-send requirement remains. A tested room policy branch alone
does not establish a room membership ACL or authorized fan-out producer.

Full runtime-bundle admission (constitution, schemas, composer, wake policy,
host and native artifact) is not implemented in this baseline. Native artifact
identity and a separately pinned wake schema must not be described as that
full bundle. There is also no authoritative cloud room-membership/fan-out
projection in the handoff. The existing filesystem room store has staff-only
participant IDs and a generic `founder` speaker, not individual human room
membership. It is not an authorization source for cloud room admission.

Native login also deliberately writes `allow_autonomous=false`; the baseline
has no authorized native autonomous-consent version producer. Account connection
does not imply consent to unattended spending. Explicitly seeded consent in
disposable wake tests is component evidence only. The human consent writer/UI,
room producer and full bundle remain explicit integration gates.

## Verification checkpoint

- 459 shell tests across 30 focused files passed, including actual-native
  stock rejection, patched success, compaction and existing public-mouth tests.
- 47 orchestrator tests across five focused files passed.
- 92 gateway tests across seven focused files passed, including post-I/O
  revocation and the member path-scoped byte route.
- The shell total includes 49 member-reader tests and five existing object-store
  tests: real gateway HTTP transport, bounded token/body waits, exact-version
  assembly and no raw/offline fallback.
- Nine packaging/build-script tests across three files passed.
- All 82 migrations applied to disposable PostgreSQL. Selected suites 160,
  165, 270, 280 and 290 passed together; the disposable database was removed.
- The separate concurrency fixture passed parallel writers, stale versions,
  receipt replay, database-death rollback and lost-acknowledgement recovery.
- `npm run check` passed without diagnostics. No full Vitest or full database
  suite is claimed by this checkpoint.

The actual native harness was exercised with synthetic data and a scripted
loopback provider, not a real model or company credentials. Tests show that
forbidden calls are denied even when emitted; they do not measure a model's
propensity to follow prompt injection. Local, remote-v1 and remote-v2
compaction restore the runtime laws, preserve fenced prior results and deny
continued work after revocation. The HTTP provider path was exercised;
deployed provider/network and complete guest acceptance remain separate.
The [release proof](native-codex/linux-x64-release-proof.json) contains the actual
cloud-node binary/fixture hashes, six compaction results, retained archive paths
and contract-only package checksum. The disposable builder was removed after
export; no production guest was replaced.

## Remaining rollout gates

1. Connect the new human file reader and complete direct-edit/proposal handling
   in the product without reopening raw-object or canonical-mount bypasses.
2. Inventory/reconcile the actual NAS company state and governed head. Verify
   the shared computer's mediated access; do not discard or duplicate live work.
3. Verify the complete packaged guest's secret custody, process/cgroup and
   egress boundary, persistent recovery through crashes, and volume retention,
   capacity and reconciliation operations.
4. Verify the accepted release Linux artifact and signed image/provider package together.
   Coordinate SQL, object gateway and guest installation; do not mix new path
   semantics with an old raw-mount guest.
5. Integrate the admitted wake policy and explicit cross-step bundle/room/hire
   authority contracts. Unknown state must not become an optional public reply.
6. Run real GPT cloud acceptance with clients closed, multiple human identities,
   permission revocation and lost acknowledgements before enabling production.

No production service, credential, SQL migration, NAS route or company mount
was changed for this source/verification checkpoint. No commit or release was
created. Disposable build/test infrastructure is not production activation.
