# Steps 0–2 review corrections

Date: 2026-08-30. Scope: the initial review and the subsequent Step 0/2
authority/privacy reassessment, including defects found while proving the
corrections. No production, Azure, credential, provider, release or commit
operation is authorized by this record. Step 3 stays separate.

## Corrections

| Finding | Implemented correction |
| --- | --- |
| A symbolic bundle label did not prove executable compatibility | A generated v2 manifest hashes the shipped implementation/import closure, every separately launched guest entrypoint, native binary/source/patch, service/bootstrap files, dependency lock and policy components. SQL admission pins it; the host rejects a different bundle/native/policy before provider work. The actual offered tool schemas/descriptions and initial prompt digest are durably recorded at launch. |
| Path-only reads lost exact content and context lineage | Private append-only observations record the path version, snapshot/content references and requested range or exact directory page. Host confirmation binds verified bytes/result digest to the observation; a changed path during transport fails. Every prewarm/turn/compaction boundary records exact fenced-output digests and confirmed-read references with durable parent ancestry. |
| Low effort was a host default, not immutable run provenance | Admission resolves `qorpera.model-reasoning/v1` with `effort=low` and `overrides=none` from the bundle. Both value and policy digest are immutable on the run, included in native authority and run provenance, and checked by the host and launch RPC. The native turn consumes that admitted value. |
| Rollout instructions used the legacy gateway and conflated proof scopes | The production sequence uses the leased cloud bootstrap worker and its v3 organization-plus-agent finalizer. The contract and Step 1 record separate historical real-GPT mouth acceptance from the current integrated assembly's uncompleted live gates. |
| A missing membership fell through SQL NULL checks in credential grant/revocation | Forward `18200` requires a current authenticated member, locks that membership, and checks company-owner/admin or exact personal ownership before any grant/revocation. Outsiders, another company's owner, viewers and unrelated members cannot use known IDs to mutate custody. |
| Recreated Step 0 wrappers reopened the broker's control-plane surface | Forward `19850` revokes PUBLIC/API/broker execution on the eight actual wrapper OIDs, then grants only the intended authenticated surface. SQL 306 runs after all migrations and still permits exactly three broker functions. |
| A private run's membership FK prevented removing a member; cascading its session would lose history | Historical sessions/runs reference the stable human identity. Separate insert/update guards require current membership for new private audiences. Removal closes private sessions, deletes execution bindings and fences access while retaining canonical inputs and run attribution. |
| Private Co-Founder audiences could not read authorized shared state | Private runs can read shared paths under both member and staff grants. Private-to-shared writes become exact proposals. Drafts and staged bytes remain restricted to their originating member; publication requires that member's consent plus normal target authority, rechecked at the last SQL publication boundary. |
| Follow-up: pending capture tickets could revive after promotion/reinvitation, or race a downgrade | Losing issuer authority cancels pending tickets and revokes operation grants durably. Capture INSERT locks and revalidates the issuer's membership. A two-connection regression reproduced the stale-ticket race before the guard and now verifies serialization for both grant and capture admission. Existing invalid grants/tickets are quarantined on upgrade without deleting credential envelopes. |

The policy/component hashes cover the implementation that exists, not promised
later-step behavior. No new wake kind, worker policy, connector product or
constitution is claimed. Higher-effort workers remain a later versioned policy;
job flags cannot select them today.

## Source and migration boundary

- `scripts/generate-cloud-runtime-bundle.mjs` generates the manifest, compiled
  constants and source-only activation migration; `--check` and the guest
  packager reject stale output. The packager and generator share one entrypoint
  list, including child processes that are not ordinary imports.
- `19700_runtime_executable_provenance.sql` pins effort and validates native
  launch provenance. The old launch RPC is unavailable to API roles.
- `19800_runtime_read_observations.sql` stores private observations,
  confirmations and context-view lineage, reuses current cloud/path authority,
  and extends existing retention through its owner-preserving private helper.
- `19900_runtime_bundle_activation.sql` activates the generated v2 bundle.
  It has not been applied live. Once shipped, another bundle requires a new
  activation migration; do not regenerate an already applied migration.
- `18200_cloud_secret_member_authority.sql` is a forward correction to the
  frozen custody baseline; `17000`, `18000`, and `18100` remain unchanged by
  this correction lane.
- `19850_runtime_audience_authority.sql` corrects wrapper ACLs, historical
  audience references and publication privacy before the source-only `19900`
  activation. Its new helpers are private and explicitly granted to the exact
  retained SECURITY DEFINER owners, including split-owner deployments.
- `cloud-native-company-runtime.ts`, `cloud-native-run-tool-session.ts` and
  `cloud-codex-tool-session.ts` consume the pins. The native result fence and
  Company File gateway require durable view recording before provider release.

The generated manifest and SQL parity check are the source of bundle hashes;
this document deliberately does not introduce another manually maintained pin.
Historical v1 inputs/runs are not relabeled. Their unknown effort stays unknown,
and incompatible work fails closed instead of being silently rerun.

## Read and privacy semantics

Reads remain live. A disjoint Company File mutation does not invalidate an
observed path; a changed version of that path before confirmation does. Writes
keep the existing expected-version checks and protected proposal rules. The
permission read set remains conservative and is rechecked even for an empty
provider batch or compacted view.

Private conversations do not receive automatic Company File grants. Existing
member/staff path authority is still required. They can consume authorized
shared state, but moving their output into shared state requires the source
audience owner's consent. An ordinary write does not additionally require
administrator status; a protected target still does. Consent is exact-plan,
current-version and time bound; skip, expiry, revocation, another approver, or
changed policy prevents publication. The published revision records a shared
effect and retains its private-source run/requester/sponsor/approver linkage.

Observation, host confirmation and authorized provider view are distinct. A
private receipt records what was prepared for release; it is not proof that a
remote provider received or completed a request. Lost or uncertain transport
does not become permission to repeat external work. Failed/stalled recording
and cancellation release no later provider result.

Private tables contain metadata, tool schemas, hashes and references, not file
text, provider scratchpad or credentials. They are not directly accessible to
members, models, the broker or generic service-role clients. Required content
objects remain under existing current-ACL access and the 30-day audit retention
window, or longer while their run is active. This is not a whole-company
checkout, a new source of authority, or a replacement Company File.

## Verification

Historical initial correction result: 381 focused TypeScript tests across 24 files and six Node
bundle/packaging tests passed. The 101-migration SQL driver passed, including
real native/path fixtures, split-owner retention and restart/concurrency
checks. `npm run check` passed with no diagnostics or formatting changes;
`git diff --check` passed.

The initial checks used synthetic/faux providers and disposable PostgreSQL only:

- `node --test scripts/generate-cloud-runtime-bundle.test.mjs`: canonical
  manifest serialization, every packaged entrypoint, helper/source drift,
  stale generated constants/activation, native pin/patch mismatch, preserved
  Step 3 exclusion, and exact pins in the actual packaged native host.
- Focused shell tests cover exact bundle/effort rejection, durable native
  start, range/hash/receipt matching, directory paging, unconfirmed reads,
  current-authority revocation, compaction, cancellation and public-mouth/
  secret-tool regressions.
- Additional organization, agent lifecycle, publication, trail, broker,
  bootstrap, member-gateway and app-server hierarchy tests passed without
  changing their production/deployment boundaries.
- `node scripts/test-runtime-provenance.mjs`: all 101 migrations and exact
  SQL/generated-manifest parity; split function owners; SQL 305, 310, 315 and
  the real SQL 290 native/path fixture; immutable provenance, incompatible
  launch rejection, range/version checks, disjoint writes, context replay,
  compaction ancestry, concurrent receipt deduplication, and database restart.
  An upgrade clone with a real pre-migration v1 run proves that its bundle,
  input and other provenance are unchanged, unknown effort remains unknown,
  and the new runtime refuses incompatible historical execution.
  The test removes only its generated database container and test volume.
- `npm run check` verifies formatting, bundle freshness, dependency/import/
  cloud-boundary checks, type checking and browser smoke. Packaging acceptance
  is component evidence, not a new signed image.

No real provider, production credential or deployment endpoint is used by these
checks. Earlier signed v55/v56 or Step 1 evidence is not evidence for the new
source bytes.

### Subsequent authority/privacy reassessment

Final corrected source verification passed: 367 focused TypeScript tests in
26 files (326 shell, 39 gateway, and two organization app-server cases), three
Node bundle/packaging tests, `npm run check` with no fixes or diagnostics, and
`git diff --check`. Tested source hashes were identical before and after the
verification commands.

The current regression driver applied all 103 migrations, ran SQL 305, 306,
307, 310 and 315, then exercises both shared and private variants of SQL 290's
real native admission. It does not replace native authority helpers. Coverage
includes exact publication consent, private proposal/content filtering,
active/cancelled membership removal, pre-upgrade private history, issuer
revocation/reinvitation, invalid legacy grant/capture quarantine, independent
function owners, concurrent grant/capture-versus-downgrade transactions,
read/context replay, and PostgreSQL restart. The managed-Storage fault fixture
uses Storage's delete context only to simulate object loss in its rolled-back
transaction; Qorpera retention/authority triggers stay enabled.

The combined production-schema rehearsal also passed: all 29 missing migrations
through `19900`, including `18200` and `19850`, applied against captured schema
`aa4c1baf0b3b410361ea18c2107e5e34236ffedbf591c18b97044d95d88e4fc0`.
It retained split function owners and the teardown interlock, ran SQL 305,
306, 307, 310, and 315 plus the shared/private native path fixtures, verified
the exact active bundle, and retained only the broker's three permitted
functions. Both verification drivers removed their disposable databases and
test-only volumes; no production operation was performed.

Final command logs, source hashes, and the combined rehearsal are under the
authoritative worktree's
`.artifacts/runtime-step-separation-20260828/step0-2-authority-final-20260830.MKwEsb`.
The rehearsal `manifest.json` SHA-256 is
`a67380829635db75813d28a865deb9f0ae75fac93916f2b6fdbd876404e84eb6`;
`source-verification.json` SHA-256 is
`796337c26fa711e7a4557509443564cd8f9847c14b7fa68ea85d732eb3dffcdd`.
The verification record contains exact working directories, argv, complete
command logs, exit status, and before/after source pins. These are source and
schema-rehearsal proofs, not live migration or signed-runtime acceptance.

The separate production lane's frozen signed-v56 real-GPT custody and cleanup
handoff is complete, with final proof SHA-256
`ca07df9eed96ccc3681f7f5b1eb33150eae5a01518db192929655e98f55fea78`.
Its canary, non-exposure scans, and cleanup certify its frozen bytes only;
they do not certify this newer runtime bundle. Its evidence remains unchanged.

## Live gates retained

1. Use the refreshed combined schema/owner rehearsal and correction hashes in
   the production lane's exact target/rollback packet, including `18200` and
   `19850` before `19900`. An older 17- or 24-migration rehearsal does not
   certify this assembly. Rehearsal does not authorize a live application.
2. Build and accept a compatible signed runtime from the frozen bundle and
   exact native artifact; preserve existing proof candidates and evidence.
3. Carry forward the separate signed-v56 custody/cleanup evidence without
   relabeling it; accept the newer compatible runtime against its own exact
   signed bytes and required live proof.
4. Obtain approval for the exact live SQL/runtime window, install paused,
   activate the matching bundle, and verify cloud bootstrap/v3 projections.
   Inventory incompatible pending inputs/runs rather than repinning them.
5. Perform live two-member/one-agent privacy, path and cutover acceptance with
   both member clients offline. Only then refresh integrated production status.

These are live verification/rollout gates, not authorization to incorporate
Step 3 or expand connector functionality into Step 2.
