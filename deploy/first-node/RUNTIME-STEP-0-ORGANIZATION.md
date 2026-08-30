# Runtime Step 0 organization implementation

**Status:** Source implementation, disposable-database acceptance, and a
production-schema migration rehearsal are complete; live production migration,
organization-aware cutover, and offline multi-member acceptance remain pending

**Contract:** [Qorpera Runtime Contract](../../QORPERA-RUNTIME-CONTRACT.md)

## Implemented boundary

The Step 0 organization kernel is company-centered. Canonical organization
documents live in the Company File; SQL rows are closed enforcement and query
projections bound to exact immutable path versions.

Implemented source behavior:

- one Co-Founder staff identity and one formation identity per company;
- one canonical `organization/agents/<staff-id>.json` Co-Founder document;
  `organization/formation.json` references that identity and does not duplicate
  mutable agent state;
- one silent kickoff input for the initial member-private Co-Founder session;
- one mirrored first-run ledger entry binding that same input to the canonical
  agent path version, so repair and replay cannot manufacture a second kickoff;
- one separate private Co-Founder session for each writable human member and
  none for viewers;
- shared-state reads from a private conversation under current member/staff
  grants, with explicit originating-member consent before private output is
  published into shared state;
- private proposal metadata and staged content restricted to that audience,
  and retained private history that does not block membership removal or
  preserve execution authority after it;
- formation, department, responsibility, measure, project, department-staff,
  and project-staff projections with bounded schemas and lifecycle checks;
- at most one active primary department per staff agent;
- department resource scopes requiring both active department membership and
  an exact current grant for staff access;
- closed department, project, room, and exact-version resource grant
  projections on canonical agent documents, including subset checks that stop
  an agent from delegating authority it does not possess;
- grant references do not manufacture department, project, or room membership;
  the corresponding canonical organization object remains authoritative;
- canonical organization paths treated as protected and non-deletable;
- exact UTF-8 document/hash validation and same-transaction Company File head,
  path-version, and organization-projection advancement;
- initial Company File directories for agents, departments, and projects, plus
  reference-only `organization/formation.json` and the Co-Founder agent
  document derived from server-issued bootstrap identities;
- recoverable upgrades of an already governed Company File, advancing no more
  than one missing path per durable snapshot while preserving every existing
  byte and evolved Co-Founder revision;
- a service-only cutover that imports and projects every organization document
  atomically, while the legacy projection-blind route fails closed for such a
  tree;
- governed agent create, edit, archive, restore, and permanent-delete
  operations over the canonical agent path, with exactly one startup wake, no
  template artifact, Co-Founder archive/delete protection, and dependent
  authority and owned-artifact tombstoning; and
- a typed desktop hierarchy rebuilt from the closed cloud organization and
  staff projections. The Co-Founder precedes departments, active projects and
  rooms remain semantically distinct, inactive organization is outside the
  primary surface, and local recency is not authority.

No department or project is created merely to populate a template. No artifact
is created with the Co-Founder. Department and project rooms, wakes, routines,
workers, dashboards, connectors, and behavioral overlays remain in their
ratified later runtime orders.

## Source map

- `supabase/migrations/20260828019000_member_private_staff_sessions.sql`
  owns audience-scoped session access.
- `supabase/migrations/20260828019100_company_organization_kernel.sql`
  owns organization identities, lifecycle projections, and atomic company
  bootstrap.
- `supabase/migrations/20260828019200_company_organization_projection.sql`
  owns exact Company File path bindings, protected mutation projection, and
  organization-aware service cutover.
- `supabase/migrations/20260828019300_runtime_step0_bootstrap_provenance.sql`
  owns the leased cloud bootstrap, the initial runtime registry, exact
  Company File genesis or recovery, and one first-run admission.
- `20260828019700_runtime_executable_provenance.sql` through
  `20260828019900_runtime_bundle_activation.sql` replace symbolic-only bundle
  admission with exact implementation/native pins, immutable resolved effort,
  launch catalog/context digests, and private read/provider-view provenance.
  Historical records are not relabeled.
- `supabase/migrations/20260828019400_runtime_step0_audience_context.sql`
  owns the closed audience/context projection used by admitted runs.
- Forward `20260828019850_runtime_audience_authority.sql` closes the recreated
  wrapper ACLs, separates historical audience identity from live membership,
  and enforces private-context publication consent. It precedes the generated
  runtime activation and does not alter the frozen Step 2 custody migrations.
- `supabase/migrations/20260828019500_runtime_step0_staff_lifecycle.sql` and
  `20260828019600_runtime_step0_company_agents.sql` own staff deletion,
  artifact ownership, canonical agent documents, grants, lifecycle projection,
  and the organization-plus-agent service cutover.
- `packages/object-gateway/src/company-bootstrap.ts` materializes the verified
  bootstrap tree; `member-company-file.ts` supplies exact document bytes only
  to organization-aware apply RPCs.
- `packages/shell/src/cloud-company-agent.ts`,
  `cloud-company-organization.ts`, and `hosted-primary.ts` own closed cloud
  agent, organization, and hierarchy parsing.
- `packages/coding-agent/src/core/app-server.ts` exposes only the closed
  hierarchy view to the fixed shell; `packages/shell/userland/renderer.js`
  renders that projection without acquiring mutation authority.

## Verification

The focused SQL driver applies the complete migration chain to disposable
PostgreSQL and verifies idempotent creation, exactly-one kickoff, no seeded
artifact, per-member privacy, viewer exclusion, initial organization-aware
cutover, exact projection binding, one-path recovery, evolved Co-Founder replay,
agent creation and lifecycle, bounded grant delegation, owned-artifact
tombstoning, department and project schemas, department ACL composition,
protected review, deletion rejection, byte mismatch rejection, and legacy
publisher rejection.

Focused TypeScript tests verify the closed bootstrap/session parser, initial
Company File seeding, one-path governed upgrades, immutable publication,
canonical agent document preservation, exact organization-document delivery,
replacement-client hierarchy reconstruction, inactive placement, and the
renderer-facing field allowlist.

The complete production delta was also rehearsed without production writes
against the captured production schema. All 24 missing migrations (`04000`
through `18100`, followed by `19000` through `19600`) applied in their required
order. SQL cases 305, 310, and 315 passed with split production/migration
function owners, and the disposable database was removed. The immutable proof
is under
`.artifacts/runtime-step-separation-20260828/step0-production-compat-20260830TnK2Rlr`;
its manifest SHA-256 is
`55ec636b36a6787a12a95de39a44eb3f9d683becc9ae0372093f017425d3a0de`.
This proves migration compatibility, not live activation.

That 24-migration production rehearsal predates `19700`–`19900`. The new
executable/read-provenance slice has a separate complete disposable replay,
including split-owner retention, exact read ranges, compaction ancestry,
revocation, concurrency and restart. The later authority/privacy
corrections add `18200` and `19850`; the combined chain now has 103 migrations,
with SQL 306 run after all Step 0 wrappers as well as custody. The latest
combined 29-migration production-schema rehearsal passed with the corrected
private audience, capture/grant revocation, exact bundle, and broker privilege
tests. It is recorded with the correction evidence, not retroactively attributed
to the historical 24-migration result. A compatible signed package and exact
live rollout approval are still required. See
[Steps 0–2 review corrections](RUNTIME-STEPS-0-2-REVIEW-CORRECTIONS.md).

## Production gate sequence

The organization cutover is not a direct call to the legacy
`qorpera_enable_company_path_gateway` RPC. After the prerequisite and Step 0
migrations are present, migration `19300` has enqueued a bootstrap job for each
established company. The deployed `CompanyBootstrapProvisioner` must claim that
job, verify and preserve the current immutable base tree, add only the missing
canonical organization entries, and finalize through
`qorpera_finalize_company_bootstrap`. The finalizer supplies the exact verified
organization-document map to `qorpera_enable_company_path_gateway_v3` in the
same transaction that advances the Company File head and projections.

The production sequence must verify the completed bootstrap job, its output
snapshot, path-gateway/head equality, exact formation and Co-Founder path
versions, one first-run input, and distinct member-private Co-Founder sessions.
Calling the legacy projection-blind cutover before that drain is prohibited.

Live multi-member acceptance requires two real authorized members in an
isolated live company or preview environment. Both physical clients stay
offline during the cloud operation. Evidence must show that both members bind
to the same canonical Co-Founder identity while receiving different private
sessions; neither can read the other's transcript; a viewer receives no
private session; the canonical agent/path version and organization projections
match the live Company File head; and no desktop process, local filesystem, or
member device supplies execution authority. Synthetic disposable SQL remains
component evidence and cannot close this gate.

## Remaining gates

These are deployment acceptance or later-order behavior, not missing Step 0
source machinery:

1. Apply the migrations through the coordinated production database lane after
   the Step 2 deployment proofs and exact live target approval are frozen.
2. Execute and verify the bootstrap-worker drain in the corrected production
   runbook; its finalizer must use
   `qorpera_enable_company_path_gateway_v3` and supply the exact canonical
   organization document map read from verified immutable objects.
3. Run live two-member and one-agent path/ACL/cutover acceptance with all
   member clients offline.
4. Bind room grant identities to the authoritative room-membership producer
   before Order 3 admits room ingress; the Step 0 rows are intentionally inert
   for wake fan-out.
5. Add Co-Founder routing, structured escalation, and file-change wakes in
   Order 3; responsive formation workers and project execution in Order 5;
   dashboards in Order 6; connectors in Order 7; routines/listeners in Order 8;
   and thin role overlays and formation behavior in Order 10.

Until gates 1–3 pass, this record proves source behavior only and MUST NOT be
represented as production Order 0 acceptance.
