# Runtime Step 2 resumed; Step 3 held

Date: 2026-08-28. **Step 2 remains incomplete. Managed Storage and human file
acceptance passed. Signed v50 includes the verified scratch and auth-only
startup fixes. Its canonical turn identified a successful HTTP 204 being
misread as an authority failure before model admission. That correction is
verified but not yet committed or built into a signed replacement.** See the
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

Investigation independently reproduced a startup defect: the governed adapter
created scratch directly under Linux `/tmp`, while its
unchanged containment validator requires a deeper private working directory.
The fix nests `runtime/` below the unique temporary allocation and removes
that entire allocation on exit. A cloud probe reproduced the original exact
layout rejection and verified the fixed adapter reached the pre-model gate
under the actual service containment settings. Both probes used an empty
auth home and deliberately stopped before any model request; the installed
native binary and namespace helper remained unchanged.

The new regression failed before the fix and passed afterward. All 57 focused
adapter/run/runtime tests and `npm run check` passed. The approved fix was
committed as `4504d8b081efa09cdfc97b69571db5bd55d7d3a5`, with candidate pins
in `5de32dca3fceb032cf278ad85146808da5732582`. Signed v49 passed Linux packaging,
clean boot, containment and the pre-model startup probe. Signed v48 and its
historical evidence remain intact; neither result is a real-GPT pass.

The next independently admitted human turn,
`be07fb2f-0cb7-47c0-abef-2633e70829bd`, ran on the exact signed v49 image and
failed before durable native model-start admission, with zero public sends.
It was not retried. Its VM was stopped without force after verifying the
terminal job, inactive worker and exact image; identity and recovery volumes
remain preserved. A metadata-only diagnostic inside its cloud identity VM
found one auth file and two incidental Codex files in the login capsule. No
credential bytes left that VM and the capsule was not modified. Administrative
read-only checks of the terminal run's four context sources passed without
changing a lease or invoking admission.

This independently reproduced a second startup defect: the login host had
sealed every CLI file, while governed execution correctly
requires an auth-only identity. The fix seals only `codex/auth.json` for Codex
login and projects only that required path when restoring a governed capsule.
The full archive is still validated, including ignored entries, duplicates,
path collisions, traversal, modes and size bounds. Missing auth fails closed.
Refresh preserves only the credential path and still requires current authority;
the runtime's rejection of extra configuration is unchanged.

Both new regressions failed before the fix. All 92 focused tests pass on macOS
and cloud Linux. A before/after probe with the actual installed Codex binary
and service containment reproduces the old auth-only rejection and reaches
verified configuration with the fix; it deliberately stops before a model
request and uses synthetic credentials only. The approved fix and v50 pins
were committed as `a20dd1ef0dbdcce31166789053b2d7bb5ab2a929`. Clean-source
Linux packaging, clean boot, containment and both startup probes passed for
v50, which received off-node signed provenance and was activated only in the
isolated preview. Prior signed images and their evidence remain preserved.

After the router returned, the expired preview tunnel endpoints were replaced;
the actual cloud VM verified their HTTPS certificates and gateway readiness.
Production endpoints, DNS and TLS policy were unchanged. Canonical human run
`5e03dc98-87d0-483d-a8ff-9af2f5c6bd6e` used exact signed v50 but failed before
native model admission, with zero public sends. Its terminal VM was stopped
normally, without retry, while retaining identity and recovery volumes.

Managed API logs identify the actual v50 failure: the context and native
authority calls succeeded, then `qorpera_assert_company_path_reads` returned
HTTP 204, as expected for a void RPC. The client incorrectly required JSON
and rejected that successful response. This is stronger evidence than the
generic bridge error; the earlier scratch/auth defects were independently
reproduced and are not proof that either failed turn reached those stages.

The corrected client accepts an empty 204 only for the two void RPCs,
`qorpera_assert_company_path_reads` and `qorpera_verify_company_path_file`.
Value-bearing RPCs, empty non-204 responses, denials, cancellation and timeouts
still fail closed. Three regressions failed before the correction, including
the runtime-to-mouth flow through the real HTTP control adapter. The fix
passes 210 focused tests, all three packaging tests and the full check on
both macOS and cloud Linux. An actual managed
API probe verified 204 success and 400 rejection using the patched client;
it reverified an existing synthetic object without changing the company head,
uploading company bytes, admitting execution or invoking a model.

The rebuilt Linux package changes only the host bundle. Proposed v51 pins
name the verified bytes, but no v51 image has been built or signed and the
correction remains uncommitted. The preview orchestrator is paused. This
does not complete real-GPT injection, revocation or recovery acceptance.

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
   runner/provider and fresh cloud-native login are operational, with the
   orchestrator deliberately paused. The independently reproduced scratch and
   auth-only defects are fixed in signed v50. Its managed trace then identified
   the successful-204 parsing defect described above. That tested correction
   and v51 package pins await an additional authorized commit and signed
   restaging. Preserve existing signed candidates, repeat clean boot,
   containment and startup checks, then admit a new human turn for real-GPT
   injection, revocation and recovery acceptance. No failed run is retried.
   No push, release or production change is authorized by restaging approval.
2. Before production enrollment, recheck/reconcile the two missing NAS files
   without losing either live state, and verify replacement-node fencing and
   authorized recovery. The completed same-node backup import does not confer
   fresh execution or public-send authority.

Wake semantics, room ingress, hiring/first-run/recovery wake producers,
autonomous-consent UX and cross-step bundle composition are held for Step 3.
They are not prerequisites for Step 2's fenced human-turn acceptance.
