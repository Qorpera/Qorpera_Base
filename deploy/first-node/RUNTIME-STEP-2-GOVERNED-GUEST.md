# Runtime Step 2: governed Company File and native guest

Date: 2026-08-28. Status: source implementation and component verification.
**Historical checkpoint; production unchanged and Step 2 incomplete.**
The later signed v52 preview and real-GPT VM-recovery evidence are in
[RUNTIME-STEP-2-V52-ACCEPTANCE.md](RUNTIME-STEP-2-V52-ACCEPTANCE.md).
This record supersedes the initial
native-boundary inventory where it describes later implementation. It does
not supersede the runtime architecture or authorize a production cutover.
The Step 2-only continuation and explicitly deferred Step 3 handoff are
recorded in [RUNTIME-STEP-2-RESUMED.md](RUNTIME-STEP-2-RESUMED.md).

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

`20260828012000_member_company_file_commands.sql` and the member gateway now
bind human edits and proposal reviews to immutable commands, exact content
digests and current path/member versions. Protected edits require an explicit
authorized human review. Skip is a rejection, not consent. An uncertain save
can be resolved only by its original command identity; it is not silently
submitted as new work. Commands expire after ten minutes, and staged bytes are
retained while the command is pending.

The opt-in product integration uses a fresh display-only root, disables local
Company File materialization/publication and legacy mutation routes, and opens
an isolated file window. The window provides bounded UTF-8 text editing
(32 KiB), exact previews, explicit approve/skip and uncertain-command recovery.
It does not execute Company File content or represent local display files as
the company. Binary/large-file editing is not provided by this text surface.
Member/path authority and JWT expiry are rechecked independently of the UI.

`20260828013000_member_session_attachment_authority.sql` and the member
attachment gateway bind image upload and retrieval to the human, session,
canonical input identity, exact hash, size and media type. A pre-input proof
expires after ten minutes; only the exact admitted input can make it durable.
Current authority is checked before and after I/O. This closes the attachment
dependency on the legacy raw-hash route. Limits are five images and 8 MiB per
input, without automatic retry of ambiguous publication. Legacy sweep D17
(`20260930416000`) dropped this upload authority with its table; on folder-v2 a
chat image is a folder file (`20260930260000`).

These product and SQL paths have component/browser-fixture evidence, not a
released-client or production cutover proof. **Do not enroll Company41 until
the coordinated package, gateway, SQL and shared-computer gates below pass.**

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

Exact-object native reads/staging
(`20260828008000_native_company_object_staging.sql` and
`cloud-native-company-objects.ts`) are gone (legacy removal, step C;
migration `20260930190000`): they served only snapshot-v1 companies. A run's
bytes move through the company folder's routes, whose native credential
gateway `native-objects.ts` checks. The trusted host holds that credential;
the harness does not.

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
reconciliation and never automatically rerun. A forced stop of a disposable
cloud VM preserved exact durable records. Completion replay, interrupted-work
quarantine, expired-result retention, quota failure and imported-volume recovery
passed with synthetic control. Import does not restore expired authority.
Actual replacement-node fencing and authorized operator reconciliation still
require acceptance; a same-node volume import does not establish either.

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
volume requires reconciliation. Bootstrap restores private directory ownership
and mode before worker startup; LXD volume import alone can restore the mount
root with traversal permissions that the worker must not accept.

The separate `qorpera-company-runner` and `qorpera-native-company-host` services
use separate accounts. The host launches the governed native process through
root-owned Bubblewrap and a fixed helper in private user/mount/PID/network/IPC/
UTS/cgroup namespaces, with empty capabilities and no nested user namespaces.
The native filesystem contains only read-only system files, its auth-only home,
bounded scratch space and exact per-execution Unix sockets. It cannot see the
host's service credentials, other process trees or canonical company mounts.
There is no unsandboxed fallback, including login/status in the governed mode.

An opaque TLS relay permits only the fixed native provider hosts on port 443.
It validates destination/SNI, rejects private DNS answers and ECH, and bounds
connect time, idle time, connections, attempts and total bytes. The host never
decrypts provider traffic. The native process has no general network route;
model-visible tool effects remain separately authorized by the tool boundary.

The trusted host unit uses `ProtectHostname=private`, full `/proc` for namespace
setup, and no parent kernel-tunable/log path masking. Such masks prevent a fresh
unprivileged `/proc` mount. Non-root identity, empty capabilities and the child's
private filesystem/PID namespace enforce the relevant denial instead; no host
sysctl or global AppArmor relaxation is required. The exact unit configuration
passed on Ubuntu 26.04, including host-secret/proc denial, fixed sockets,
revocation, verified provider TLS, the release native binary, cgroup limits and
termination of detached descendants. This probe is not a full installed-image
or real-GPT conversation acceptance.

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

## Deferred Step 3 handoff (not a Step 2 gate)

Step 3 integration is paused by the user's 2026-08-28 direction. The contract
below is retained for later review, not as an instruction to expand Step 2.
The Step 2-only baseline keeps its existing required-final-send behavior and
does not import wake policies, room producers, coworker tools or wake admission.
The mixed implementation is preserved separately; see
`/tmp/qorpera-step2-resume.rN3rbf/README.md` for the snapshots and hashes.

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
room producer and full bundle remain deferred Step 3 integration gates, not
requirements for completing Step 2's fenced human-turn runtime.

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

1. Publish a reviewed, clean Step 2 source identity, update exact Linux candidate
   package pins, and verify the accepted native release with the signed guest
   and provider package. The older v45 candidate recipe is not a current Step 2
   package or a deployment instruction.
2. Coordinate SQL, gateway, guest and client installation in a non-production
   acceptance company. Verify the managed Storage cleanup fence, current
   authority and no raw-object/mount bypass, including the shared computer.
   Test real GPT with clients closed, multiple human identities, revocation
   and lost acknowledgements. Synthetic fixtures do not satisfy this gate.
3. Recheck the live company immediately before cutover, reconcile the two missing
   NAS agent-memory files, and retain the old workbench data. The read-only
   audit verified the entire current canonical cloud copy; it did not alter
   the NAS or enroll the company. Verify replacement-node recovery and an
   authorized reconciliation procedure before claiming node-loss continuity.

Step 3 wake policy, room/hire producers and cross-step bundle composition are
deferred until these Step 2 gates are complete. A later handoff becomes relevant
now only if it independently demonstrates a defect in this Step 2 boundary.

No production service, credential, SQL migration, NAS route or company mount
was changed for this source/verification checkpoint. No commit or release was
created. Disposable build/test infrastructure is not production activation.
