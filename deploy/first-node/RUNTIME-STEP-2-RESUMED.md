# Runtime Step 2 resumed; Step 3 held

Date: 2026-08-28. **Step 2 remains incomplete. Managed Storage and human file
acceptance passed. The approved cloud-native login completed, but the signed
candidate exposed a pre-model startup defect; its source fix is verified and
awaits a replacement signed image before real-GPT acceptance.** See the
[signed staging record](RUNTIME-STEP-2-STAGING.md) for exact pins and evidence.

The user's direction is to finish Step 2 before incorporating Step 3.
Parallel-track reports are preserved handoffs, not instructions to expand the
current step. Escalate a later finding only when independently reproduced as a
Step 2 blocker.

## Separation

- Active Step 2-only checkout: `/tmp/qorpera-step2-resume.rN3rbf/source`.
- Starting Step 2 tree: `aa364808b05165c088a20620ffe070adb012ba50`, from base
  `a0b692947d5c867353591b36172afcc997f0521e`, the original Step 2 patch and its
  verified supplement. All 115 manifest paths were verified before resuming.
- Paused mixed tree: `dad5c2e2c7ef240887ce841c2e1918b14163d471`.
  Its 23-path delta and full source archive are retained. The mixed checkout
  and original Git index were not changed.
- Durable separation records and archives:
  `/Users/jonas/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828`.

The active checkout contains neither Step 3 migration (200/210), wake-policy
helpers, coworker tool, nor the Step 3 scheduler changes. Existing final-send
enforcement is unchanged. The frozen independent nine-file handoff remains
available for review only after Step 2 is complete.

## Work completed after separation

### Human turns after Company File changes

The native human-turn materializer already refreshes session head and staff
pins from current cloud state. SQL 290 now exercises a second human request
after multiple governed changes, human approval and completion of the first
run. It uses the real admission, sponsorship, assignment, native lease,
context and mouth functions, with no wake-bus tables or helpers. The second
run pins the new live head and sends through the existing canonical mouth.

The stale-session-pin finding from the later wake producer is therefore not
promoted to a Step 2 blocker. Its deferred fix was not imported.

### Credential capture and refresh

The audit found two defects in the existing native capsule capture path:
hard links were accepted, and an original credential replaced by a symlink
could be silently omitted when overwriting the stored capsule.

Capture now rejects hard-linked/foreign-owned files, opens without following
symlinks, compares opened file identity, bounds reads to the validated size
plus one byte, and rejects changed files or missing original credential paths.
On Linux, directory traversal is anchored to open descriptors so renaming a
parent cannot redirect a later read. Login compatibility aliases remain
ignored. Failed refreshes leave the previous sealed capsule untouched.

### Human Company File access

The product now detects governed mode before opening the company, uses a fresh
display-only directory, and blocks legacy materialization, publication and
local file-mutating IPC/app-server routes. The file window uses current cloud
member/path authority for reads, small UTF-8 edits, exact proposal previews,
approval/skip and resolution of uncertain commands. It does not require model
allowance. Canonical file authority remains in the cloud, not this window.

SQL 120 implements immutable human commands and current-authority publication;
SQL 130 implements session/input-bound image uploads and reads. Staging a hash
is not permission to publish a file or attach someone else's private object.
Both upload and download paths are bounded and recheck authority after I/O.

### Native containment and recovery

The governed host now always launches through the Linux-only namespace boundary,
including native login/status. It exposes only the auth-only home, private
scratch paths, read-only system files and exact Unix tool/egress sockets. The
harness cannot inspect host service credentials or the canonical Company File
mount. Provider TLS is encrypted end to end through a bounded fixed-host relay;
there is no arbitrary network or unsandboxed fallback.

The actual host-unit settings passed on an isolated Ubuntu 26.04 cloud VM.
Evidence includes host secrets/environment/proc denial, capability and nested
namespace denial, private-network denial, exact tool-result fencing/revocation,
certificate-validated provider TLS, the accepted Codex release binary, kernel
resource limits and destruction of detached descendants.

Synthetic persistent-volume tests also passed after a forced VM stop: exact
completion replay, interrupted-work quarantine, expired-result retention and
capacity failure without replacing the previous record. A separately imported
backup retained identical bytes; expired authority was not revived and no work
or public message ran. LXD import restored the volume root as 0711; private
0700 provisioning was required before the probe, matching bootstrap's ownership
step. Import onto the same node is **not** replacement-node fencing acceptance.

### Managed cloud startup defect found during acceptance

The isolated preview's fresh native GPT login completed on its dedicated
cloud identity. Its first canonical human request was admitted, materialized,
assigned and accepted by a VM using the signed v48 image. It failed with zero
public sends before durable native model-start admission. No production
credential was exported, and the failed run was not automatically retried.

The governed adapter created scratch directly under Linux `/tmp`, while its
unchanged containment validator requires a deeper private working directory.
The fix nests `runtime/` below the unique temporary allocation and removes
that entire allocation on exit. A cloud probe reproduced the original exact
layout rejection and verified the fixed adapter reached the pre-model gate
under the actual service containment settings. Both probes used an empty
auth home and deliberately stopped before any model request; the installed
native binary and namespace helper remained unchanged.

The new regression failed before the fix and passed afterward. All 57 focused
adapter/run/runtime tests and `npm run check` passed. The fix is not yet in the
signed v48 image and is not represented as a real-GPT result. Its source,
regression and changelog changes remain separate from the preserved candidate.

The actual human client transport additionally passed seven live read/list
cases and six edit/authority cases: owner/friend/outsider separation, private
path denial, lost-response receipt recovery, unchanged replay identity,
changed-content replay refusal, protected-edit skip, and revocation after
the file's bytes were fetched but before they could be returned to the viewer.
No model or local canonical company checkout was required for these checks.

### Live storage inventory (read-only)

The Company41 canonical head remained
`0c0656d6-42b3-485f-86b3-a3ba1d5f6032` throughout the audit. Its tree hash is
`e6fddb19fe97d78e467069ceab6ed37bb1c12fcdf586344adc06b40303f329b4`.
The independent Supabase Storage copy verified all 206 files, 145,839,120
logical bytes and 168 distinct immutable objects. No company contents were
printed or written into a local company checkout.

The read-only NAS workbench scan matched every existing canonical file hash
and mode, with no live-only or changed files. Only two agent `memory.md` files
(408 bytes total) and their six parent/empty directories were missing from the
workbench. They remain in the verified canonical cloud copy. No missing paths
were recreated or deleted. The catalog selects `nas-object-gateway`; this audit
verified the independent Storage copy and NAS workbench, not the NAS gateway's
entire immutable-object directory. Production is still on the legacy contract;
no enrollment, remount, migration or service replacement occurred.

## Verification

- 753 focused tests passed: 566 shell tests in 36 files, 131 gateway tests in
  eight files, 47 orchestrator tests in five files and nine app-server tests.
  This includes the actual patched native binary with scripted loopback model
  responses, compaction, revocation, public-mouth and new human file regressions.
- All three guest/ephemeral/provider packaging tests passed on macOS and Linux x64. The v48
  recipe pins the complete Linux-built manifest, including the exact native
  release artifact; its test compares every non-native artifact to a fresh
  package. The cloud image subsequently passed clean boot and containment;
  its signed provenance verified off-node and on-node.
- All 84 Step 2 migrations applied; SQL suites 160, 165, 270, 280, 290, 295 and
  296 passed together on disposable PostgreSQL. SQL 290 now asserts that input
  author tampering fails at the immutable-input guard rather than manufacturing
  a corrupted canonical input. The guard itself was not weakened.
- Browser-fixture checks covered reading, editing, proposal review, read-only
  permissions and uncertain-save recovery. This is not released-client proof.
- The Linux custody, namespace/service and persistent-volume checks described
  above used only synthetic credentials/work; the provider TLS probe performed
  an unauthenticated request and did not invoke a model.
- Exact command logs, SQL results, storage/recovery evidence and source hashes
  are retained with the continuation checkpoint. No model catalog was changed.

The earlier results are component evidence, including actual cloud VM and
storage tests. Signed-guest clean boot and containment have now also passed;
real-GPT end-to-end acceptance has not. No production
service, database, credential, NAS route or company state was changed. The
cloud execution probes used only generated synthetic state. The authorized
Step 2-only source commit and signed acceptance staging are complete;
no release or production enrollment occurred.
Browser verification used the browser skill; the task's
cumulative distinct-skill count is 6/10.

## Remaining Step 2 gates only

1. Coordinate SQL, gateway, guest and client installation in a separate acceptance
   company. Prove real GPT human turns with clients closed, multiple human
   identities, revocation and lost acknowledgements, and verify the managed
   Storage cleanup fence and mediated shared-computer access. Approval for a
   temporary, potentially billable managed preview branch was received. After
   the user completed the Pro upgrade, the data-free preview
   `hurfdoempkqpzxggemhc` was created. Its replay needed `pg_cron` enabled;
   the preview now has all 102 migrations, preserving the managed-only history
   and adding the ten Step 2 migrations. Production SQL is unchanged.
   An isolated cloud gateway with preview-only credentials passed real NAS
   writes/reads, unrelated-user denial, immutable-byte validation and managed
   Storage replication. A real Storage upload was paused after preflight;
   activating cleanup then rejected its final metadata transaction. Cleanup
   removed the exact test object, and a late upload could not resurrect it.
   Temporary observer hooks were removed. The unchanged native-authority SQL
   suite also passed over certificate-verified PostgreSQL. These are managed
   component checks, not real-GPT or released-client acceptance. The isolated
   runner/provider and fresh cloud-native login are now operational. The first
   human run exposed the scratch-layout defect described above. Commit and
   repackage its verified source fix into a new signed acceptance image before
   continuing the real-GPT injection, revocation and recovery cases. Approval
   for that additional source commit/restaging was received. The replacement
   must preserve the existing signed candidate and pass clean-boot and
   containment checks before real-GPT acceptance resumes. No push, release or
   production change is authorized by this restaging approval.
2. Before production enrollment, recheck/reconcile the two missing NAS files
   without losing either live state, and verify replacement-node fencing and
   authorized recovery. The completed same-node backup import does not confer
   fresh execution or public-send authority.

Wake semantics, room ingress, hiring/first-run/recovery wake producers,
autonomous-consent UX and cross-step bundle composition are held for Step 3.
They are not prerequisites for Step 2's fenced human-turn acceptance.
