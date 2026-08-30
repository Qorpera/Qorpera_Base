# Steps 0/2 closeout record

Date: 2026-08-30. **Source verification and isolated live human-member
acceptance passed. The current corrected bundle is not yet signed or accepted
as a native cloud deployment. Production remains unchanged.**

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

The source correction and human live-check gates are closed. The signed joint
native gate and production deployment gates are not. Connector product flows
remain Order 7; Step 3 remains preserved and unintegrated.
