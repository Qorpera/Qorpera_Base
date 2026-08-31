# Steps 0/2 closeout record

Date: 2026-08-30. **Source verification and isolated live human-member
acceptance passed. The current corrected bundle is not yet signed or accepted
as a native cloud deployment. Production remains unchanged.**

The historical results below retain their original scope and pins. The later
[signed joint baseline proof](#2026-08-31-signed-joint-baseline-acceptance)
closed the baseline native gate. The
[observability addendum](#2026-08-31-observability-and-overflow-deferral) and
[non-Azure preparation](#2026-08-31-non-azure-closeout-preparation) identify the
subsequent source changes and their still-open deployment gates.

This record supplements the [runtime contract](../../QORPERA-RUNTIME-CONTRACT.md),
[organization implementation](RUNTIME-STEP-0-ORGANIZATION.md), and
[review corrections](RUNTIME-STEPS-0-2-REVIEW-CORRECTIONS.md). It does not
authorize a commit, signing, infrastructure expansion, production rollout, or
Step 3 integration.

## Live result

The final isolated acceptance attempt
`f8265103-eebd-41a2-89e6-22eb964af3b5` passed all 42 checks against managed
preview `tlnzirrtjufnexorsbic`. Its company is
`91e63658-df87-435f-8577-0f3f1778055c`; environment
`370ec509-4f4f-4842-b988-14400b420bb0`; canonical Co-Founder
`0bb5ae32-9739-4a07-84da-7a2a6250c515`.

Four actual managed Auth identities signed in through the normal password
endpoint and were verified through Auth: owner, contributor, viewer, outsider.
Their API clients and the real Company File gateway ran on the isolated cloud
acceptance VM. No fabricated JWT, SQL-created Auth user, desktop process,
member filesystem, or provider account supplied execution authority.

The live checks prove:

- idempotent company creation, hidden until the cloud bootstrap completes;
- v3 genesis and exact Co-Founder/formation file hashes and path versions;
- one Co-Founder, one typed silent formation input, and no seeded department
  or project (the separate source/bootstrap regressions cover no seeded artifact);
- explicit invitation acceptance, the same Co-Founder with distinct private
  owner/contributor sessions, and no viewer session or duplicate kickoff;
- transcript/input privacy, including rejection of another member's session;
- real shared-file bytes, exact receipt replay, stale-version rejection,
  viewer/outsider denial, and no replayed write;
- exact protected-delete review, wrong-digest/other-reviewer denial, skip
  preserving the file, and approved deletion;
- member-private paths, exact and subtree read grants, sibling exclusion,
  read-only enforcement, grant revocation with an already-issued token, and
  membership-removal fencing.

This is live human-member acceptance, not the entire Order 0 proof. The same
two-member company has not yet exercised an admitted native agent against
these ACLs. Its silent input was checked, not executed. No physical desktop UI
was tested. A separate historical GPT canary cannot be combined with this
result to claim the joint two-member/one-agent gate.

## Defect found and corrected

Managed API calls for stale versions exhausted their deadlines while ordinary
reads and validation errors returned promptly. These permanent preconditions
used PostgreSQL `40001`, which denotes retryable serialization failure. The
observed behavior is consistent with PostgREST's documented historical retry
behavior; the deployed PostgREST version was not established. See the
[upstream report](https://github.com/PostgREST/postgrest/issues/3673) and
[custom HTTP error mapping](https://postgrest.org/en/stable/references/errors.html).

Two forward migrations change only 12 error-code literals across 11 existing
functions, preserving definitions otherwise, function OIDs, owners, ACLs,
security settings, defaults and result signatures:

- `20260828019950_company_path_preconditions.sql`: stale path mutations,
  absent deletion targets, and member-object version mismatches return
  `PT412`/HTTP 412.
- `20260828019960_runtime_request_preconditions.sql`: stale path listings,
  native read confirmations/context, resource versions, proposal reviews,
  recovery reviews, staff tombstones and secret-capture versions return
  `PT412`; an absent company at the existing GC/authority lock returns
  `42501`, not a serialization retry.

These are not permission relaxations. Gateway regression tests require 412 to
preserve denial without retry, staging, fallback, publication or byte release.
The existing distinct `PT409` head-conflict rebuild remains unchanged. Actual
database serialization errors and unrelated transient storage/legacy API
behavior are outside this correction.

Only these two forward migrations were applied to the isolated preview in
this closeout. Their exact definition/metadata comparisons and rollback SQL
were retained. No production migration was applied. Final stale write,
listing and resource-version probes returned in 39–59 ms; the missing-company
denial returned in 72 ms.

## Final verification

All checks passed with tested source pins unchanged:

- 326 shell, 75 gateway, and two organization app-server tests, plus three
  Node bundle/packaging tests: 406 focused tests in total;
- all 105 migrations in the dedicated precondition driver, exact-only error
  changes under split ownership, and SQL suites 290, 295, 299, 305, 306, 307,
  310 and 315;
- simultaneous writers, stale losers, transaction interruption and lost-response
  receipt replay after all 105 migrations;
- the complete runtime-provenance driver, including native admission,
  membership/grant races, private publication, context replay, compaction and
  PostgreSQL restart;
- full `npm run check`, with no fixes or diagnostics, and `git diff --check`;
- all 31 missing migrations against captured production schema, preserving
  split owners, the legacy teardown interlock and the broker's exact
  three-function/no-table-access surface.

The new generated bundle is
`9f51c9671743a558d829b0baf85204619202b99b74f20f9f5abff865a6595a6f`.
The source base remains commit
`2e1493aecc8bf59226943e0cc714cf98284204d4`, with the corrections uncommitted.
The successful prior signed GPT run
`2f2987b2-0f4e-437b-bb37-aaba21f75dbc` certifies the earlier bundle
`5ddf7584d41d3424b9eaefc9cc1273afda1ef1da407d6e7ffa47a473a70aae24`,
not these new bytes. Both results and earlier unsuccessful live attempts are
preserved separately.

## Cleanup and evidence

All 20 test accounts across five attempts are banned, with zero Auth sessions
and zero unrevoked refresh tokens in the readback. Previously issued access
JWTs expire normally; global logout is not described as retroactive JWT
revocation. Tokens were not retained by the harness.

The two root-only preview-control/transport files were removed from cloud
tmpfs. The guest had no swap. All 338 retained proof files were scanned against
the preview control keys with no match; each attempt separately checked its
captured output/result against its in-memory credentials. The gateway is
stopped, its loopback listener is absent, and the exact acceptance VM is
stopped. Fixture companies, history, object disks, signed images and original
provider identity volumes are retained. No Azure resource or public ingress
was added in this closeout.

New evidence is under the authoritative worktree's
`.artifacts/runtime-step-separation-20260828/step2/verification/step02-closeout-20260830.BigdS9`.
It contains exact source/migration hashes, complete command logs, all live
attempts, preview apply/rollback evidence, read-only production refresh,
cleanup readbacks and the production-schema rehearsal. Its final handoff and
checksum manifest do not modify earlier sealed evidence.

## Remaining closure gates

1. Freeze the correction set in an explicitly approved local candidate commit,
   then rebuild/sign and accept the exact resulting runtime. The preview's
   old v2 activation is immutable: do not overwrite it with the new manifest
   or relabel its historical runs. A fresh compatible activation or isolated
   environment is required for the new candidate.
2. Complete the same-company two-member/one-native-agent path, privacy,
   protected-effect and revocation proof with all member clients offline,
   and reverify current-candidate GPT/non-exposure/cleanup evidence. Do not
   patch a signed guest in place or substitute a fabricated admission.
3. Obtain the separately scoped infrastructure-staging approval in the
   [production record](RUNTIME-STEP-2-PRODUCTION-ACCEPTANCE.md), including the
   retained recovery journal/private route and independently held keys.
4. Freeze the exact new production package, 31-migration delta, public recovery
   values and rollback packet; obtain the separate production-window approval.
   Keep admission paused, use the cloud bootstrap worker and v3 finalizer,
   verify two-copy recovery and governed-computer registration, then perform
   the approved acceptance. The 18 production-only migration records must not
   be deleted or marked reverted to force a source match.

At this 2026-08-30 checkpoint, the source correction and human live-check gates
were closed; signed joint native and production deployment gates remained.
The next section records the subsequent baseline native acceptance. Connector
product flows remain Order 7; Step 3 remains preserved and unintegrated.

## 2026-08-31 signed joint baseline acceptance

The later sealed `joint-signed-candidate-20260831.nm3rHk` record supersedes the
baseline native gate above. Its attempt
`5aee149a-04ff-45f1-a5bc-ec7ba7c578c1` passed on exact signed image
`564a835b47627d0758554f64691cb0c1515367cb5b58a2576133aa4a8dcb3adb`,
clean source `ce5d964343b1c5548c6f06acf66b5885c9370f8a`, and bundle
`9f51c9671743a558d829b0baf85204619202b99b74f20f9f5abff865a6595a6f`.

Two managed members used the same company and Co-Founder in separate private
conversations. The native runs used the signed bytes and low reasoning effort.
Their proof includes authorized reads, a member-private output, exact
protected-delete review/skip, one destination-bound credential effect,
grant revocation, membership removal, final delivery, and terminal jobs and
leases. Recorded non-exposure checks, encrypted preservation and cleanup
passed. The failed initial attempt remains failed and separately preserved.

This is a bounded joint proof, not a claim that every negative case was attempted
by GPT. Deterministic read-then-revoke and adversarial model attempts retain
separate component evidence. It does not certify the newer observability bundle
below or authorize production. Its preserved primary record hashes are:

- `JOINT-ACCEPTANCE.md`:
  `dd475c810c3a794340c6b290e2ee7ccbb86c363210dd77f9d26f2b11e9713810`.
- `handoff.json`:
  `6791fc789dec020fd86a950e35f97f4d82af053e4cf2f2cc9c2d219fb6f3cad1`.

The directory is under the authoritative worktree's
`.artifacts/runtime-step-separation-20260828/step2/verification/`.
Its sealed contents and all earlier proof records remain unchanged.

## 2026-08-31 observability and overflow deferral

**The newly ratified Orders 0/2 operational-observability source slice is
implemented and verified. Optional Azure overflow setup is deferred. This is
not a new signed-runtime or production acceptance claim.**

The user's decision defers rented overflow execution capacity for
development-partner testing. It does not remove the independent secret broker,
KMS, encrypted identity recovery, or live authority requirements of any enabled
execution path. No retained Azure resources, credentials or sealed evidence
were changed. No further Azure provisioning is needed to complete this source
slice. Computer/screen lifecycle, whole-computer capacity and demand,
allocation/placement history and basic usage accounting remain Order 4; Azure
placement/accounting must be implemented before overflow is enabled.

### Completed source boundary

- Canonical operator queries link company, requester, sponsor, agent, session,
  job/run, assignment, compute and exact runtime bundle to existing commands,
  reads, revisions, proposals, operation receipts and public sends.
- Native logical-model and major-tool observations retain start/end, outcome,
  safe error category and available counters. Retries retain receipt linkage;
  replayed Company File changes and messages do not appear as fresh effects.
  Post-effect result-release failure does not erase a confirmed effect.
- Enforcement observations cover initial run authority, context revalidation
  and native result fencing. Optional export is bounded and fails independently
  of authorization, effects and delivery. No tool is retried to repair telemetry.
- Human gateway request observations and provider-node measurements are
  operator-only. The human read descriptor carries its already-authorized
  actor/resource identity; the metadata change preserves every existing
  authorization check, function OID, owner, ACL and search-path setting.
- Retention, missing records, clock conflicts, stale samples, truncation and
  process-restart gaps are explicit. No prompt, transcript, file content,
  path, credential, raw provider error or arbitrary tool argument is collected.

Exact interfaces, access rules, retention and measurement limits are in
[Orders 0/2 operational observability](RUNTIME-STEPS-0-2-OBSERVABILITY.md).
In particular, native timing covers logical invocations rather than hidden
provider HTTP attempts; counters are not billing; logical bytes are not NAS
traffic; the provider-root disk probe is not whole-node admission capacity.

### Verification of these bytes

Authoritative checkout: `/tmp/qorpera-step2-resume.rN3rbf/source`, based on
`ce5d964343b1c5548c6f06acf66b5885c9370f8a`. No commit was created.
The generated runtime bundle is
`363e295a63bd7cd4e8cace47b525aed7b1b7ac3764e2d0f21f47de5a04c57207`.
The native binary and result-fence patch pins are unchanged. Step 3 is excluded.

All final checks passed:

- `npm run check`: 1,469 files checked, no fixes or diagnostics; generated
  bundle, pinned dependencies, import and cloud boundaries, shrinkwrap,
  install lock, type checks and browser-smoke consistency passed.
- 698 focused tests: 477 shell tests across 14 files, five runtime-bundle
  tests, 162 gateway tests across five files, 48 node/provider tests, and six
  Node bundle/packaging tests. All provider behavior was synthetic.
- `node scripts/test-runtime-observability.mjs`: all 107 migrations; exact
  SQL 290, 320, 306 and 321 suites; upgrade with existing admitted history;
  unchanged member-authority OID/owner/ACL/configuration; concurrent immutable
  delivery; transaction rollback; finish-before-start and receipt replay after
  PostgreSQL restart; rejection of another run's assignment, receipt and read;
  bounded projections and explicit missing measurements. The disposable
  database and its test-only volume were removed.
- `node --test scripts/generate-cloud-runtime-bundle.test.mjs
  scripts/package-lxd-provider.test.mjs
  scripts/package-lxd-runner-guest.test.mjs
  scripts/package-runner-orchestrator.test.mjs`: the six packaging tests above
  include exact embedded runtime pins and package integrity. These are
  temporary test packages, not a signed candidate or release.
- `git diff --check`: clean.

The new migrations are `20260828019970_runtime_operational_observability.sql`
and `20260828019971_member_object_observation_identity.sql`. The source-only
19900 activation was regenerated for the new bundle; no database activation
was performed. Gateway and v2 member-descriptor migration installation must be
coordinated. Existing immutable preview activations must not be overwritten.

### Remaining boundary

No further source work is known in this Orders 0/2 observability slice. Later
steps extend its records when their functionality is built; they do not wait
for an analytics warehouse or Azure overflow provisioning.

The separately recorded current-candidate signed joint native acceptance and
reviewed cloud rollout remain deployment gates, not missing analytics source
or optional overflow work. Recompute the exact migration/package/rollback
packet for this bundle; the historical 31-migration packet above is not an
approval for these new bytes. Deferring overflow does not certify the paused
custody/recovery route or authorize enabling it. No production, IAM, secret,
provider-account, infrastructure, release or Step 3 operation was performed
for this implementation.

## 2026-08-31 non-Azure closeout preparation

The new bundle remains `363e295a...`. Its unpublished provider, orchestrator,
gateway, ephemeral-host and guest packages have been generated from the current
working tree. All seven focused package/bundle tests and 20 JavaScript syntax
checks passed. The 253 recorded package inputs, Git HEAD and index were
unchanged during packaging. The native Rust binary and retained OCI/Cosign
inputs were hash-verified and reused without executing or rebuilding them.
These are unsigned macOS-built packages, not a clean-commit provenance claim,
Linux clean-boot proof or authorization to reuse an earlier image signature.
Linux-only deployment-pin equality branches were not exercised by those tests.

The captured-production-schema rehearsal also passed all **33** missing
migrations, including 19970/19971, and SQL 290/305/306/307/310/315/320/321 plus
audience/provenance cases. It preserved split ownership, the legacy teardown
interlock, synthetic admitted-history fixtures, exact member-descriptor
OID/owner/ACL/configuration, and the broker's three-RPC/no-application-table
surface. Both disposable databases and their test volumes were removed.
The first attempt's scratch-only final audit-query error is retained; no
source defect or live database change resulted.

Replay evidence is `step02-observability-production-rehearsal-20260831.BUfaqW`
under the verification directory above. Its `manifest.json` SHA-256 is
`fa835ad427456e48c9ba3dd1ff42b7c596fad74e8b8f7837c9416862ded1240f`.
This uses the captured schema, not a new production inventory or production
rows. The 18 production-only migration records remain outside the apply set.

Unpublished packages and their exact input/artifact inventory are retained at
`/tmp/qorpera-step02-observability-packages.KAynev`. The provider installer and
image build/verification scripts still pin historical artifacts and must not
be used to install these new packages unchanged. They need final candidate
pins after the approved clean-source/image freeze; the orchestrator artifact
itself is unchanged. The rehearsed 33-file list is not yet an executable
production approval or complete live rollback packet.

A bounded, read-only on-prem preflight confirmed that the company node is
reachable, the retained signed image is present, the proof guest is stopped,
and the host provider service is disabled/inactive. It did not read credentials,
unlock signing keys, start services or contact Azure. The latest sealed
custody/private-route record remains paused; restored configuration is not
evidence of a serving broker or independent recovery service.

Remaining execution is therefore the approved clean candidate/signature,
exact-bundle cloud acceptance through an available custody/recovery path,
final installation pins and live preflight/rollout packet. The user's exclusion
of Azure work remains in force. No Azure service, route, KMS or enrollment was
changed to satisfy this gate, and no custody requirement was bypassed. Step 3
is still excluded; production, Git history and the sealed baseline proof are
unchanged.
