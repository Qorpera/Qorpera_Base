# Steps 0–2 amendment ratification record

Date: 2026-09-02. Branch `codex/steps-0-2-fable-handoff`, checked out at
`~/work/Qorpera_Base-runtime`. Base commit `5a3c72890` (contract with the
2026-09-01 founder amendments). **This is a source record. Nothing in it is a
signed-runtime, preview, or production acceptance claim.**

This record follows the [closeout](RUNTIME-STEPS-0-2-CLOSEOUT.md) pattern and
tracks Phase A of the Fable takeover: ratifying the Orders 0–2 codebase
against the amended [runtime contract](../../QORPERA-RUNTIME-CONTRACT.md)
(decision record: `~/Qorpera_Base-Step3/QORPERA-RUNTIME-CONTRACT-ADDENDUM.md`).
Phase B (signed candidate, live two-member/one-agent proof, production
window) follows the closeout's remaining closure gates and is not started by
this record.

## Applied-migration facts before choosing the migration strategy

Read from the sealed evidence under the stale Codex worktree
`~/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/`
(no live database was queried for this record):

| Environment | Evidence | Ledger | Organization migrations 19100/19200/19600 |
| --- | --- | --- | --- |
| Production `wovsmjvghnbcbfazdtvr` | `step02-closeout-20260830.BigdS9/production-readonly-final.json` (2026-08-30T20:59:52Z, read-only) | 92 records: 74 shared with source, 18 production-only (`20260826110000`–`20260827000000` legacy Company Computer lane, `20260827043000`–`046000` mobile push) | **Never applied.** All 33 source files from `20260828004000` onward are missing, `19100`–`19971` included. |
| Isolated preview `tlnzirrtjufnexorsbic` | `step02-closeout-20260830.BigdS9/preview-readonly-inventory.json` (2026-08-30T20:15:33Z) plus the closeout's later `19950`/`19960` forward corrections | 119 records through `20260828019900`, then `19950`/`19960` | **Applied**, with one completed bootstrap job (profile `38500000-…0010`) on the department layout. |
| Rollout packet v2 (2026-09-01) | `production-rollout-packet-v2-20260901.vTXZr9/HANDOFF.md` | rehearsed final ledger count 125 = 92 + 33 | Rehearsal only; production untouched. |

The production Company File tree (`nas-readonly-final-20260829T093634Z/tree-manifest.json`,
206 files) has no `organization/` or `departments/` prefix; its top-level
directories are `Recovery/`, `agents/`, `inbox/`, `files/`, `connectors/`,
`step2-acceptance/`.

## Decision: replace the department migrations in place

`20260828019100_company_organization_kernel.sql`,
`20260828019200_company_organization_projection.sql` and
`20260828019600_runtime_step0_company_agents.sql` are rewritten in place (with
the department references in `19300` and `19500` corrected in the same files)
rather than followed by a migrate-on-top file, because:

1. Production has never applied any of them, so production's first
   organization schema is the responsibility model. No department table is
   created and dropped on the production database, and the contract's "no
   department object" rule holds in the schema itself.
2. The isolated preview is disposable acceptance state. Closeout gate 1
   already requires "a fresh compatible activation or isolated environment"
   for any new candidate; the preview's immutable v2 activation and its
   department-layout company are historical evidence and are left untouched.
3. Every rehearsed packet (31/33-file) pins per-file SHA-256 values and is
   invalidated by any candidate change anyway; the closeout says to recompute
   the migration/package/rollback packet for the new bundle.

Consequences recorded for Phase B: the preview `tlnzirrtjufnexorsbic` cannot
be advanced in place to the new candidate; the 33-file production delta must
be re-rehearsed against captured production schema with the new hashes; the
generated bundle and its source-only `19900` activation are regenerated.

Production-applied legacy labels that are **not** changed here, because they
are already in production and are not organization objects: the free-text
`department_id` presentation link on `qorpera_profile_staff`
(`20260816005000`, frozen Staff Shell spec §"presentation link only") and the
`department` compute-identity ownership kind (`20260821001000`). Both are
recorded as follow-ups below.

## Work log

Entries are appended as work blocks close. Each ends with what is proven,
what is blocked, and what needs the founder.

### 2026-09-02, work block 1: responsibilities replace departments (Phase A.1)

Source changes, all on `codex/steps-0-2-fable-handoff`:

- `20260828019100_company_organization_kernel.sql` (rewritten): tables
  `qorpera_company_responsibilities`, `qorpera_responsibility_measures`,
  `qorpera_responsibility_measure_sources`; projects carry
  `scope_kind in ('company','responsibility')` and
  `sponsoring_responsibility_id`; formation state `organization_formation`
  becomes `responsibility_map`; `qorpera_company_organization_json` returns
  `responsibilities` with measures and sources; the Co-Founder charter names
  the four company-level responsibilities. No department table exists.
- `20260828019200_company_organization_projection.sql` (rewritten): path
  kind `responsibility` at `organization/responsibilities/<id>.json`;
  `responsibility_scoped` path resources and external-operation grants;
  `qorpera_agent_responsibility_grants`; the `qorpera.responsibility/v1`
  document projector requires exactly one employed accountable agent, an
  optional writable accountable member, a validated escalation target, at
  least one measure with at least one source, and each source to be a
  current Company File path (file for `exact`, directory for `subtree`); the
  observed entry version, snapshot and file hash are recorded as provenance
  rather than trusted from the document. Responsibility-scoped staff
  authority is the accountable agent or an agent holding an explicit
  responsibility grant.
- `20260828019300_runtime_step0_bootstrap_provenance.sql`: the bootstrap job
  mints the Co-Founder's four company-level responsibility documents
  (direction, responsibility map, resourcing, founder relationship), each
  active, accountable to the Co-Founder with the founding owner as
  accountable member, with a measure over live sources
  (`organization/formation.json`, `organization/agents`,
  `organization/projects`, `organization/responsibilities`). Genesis trees
  carry 10 entries; governed upgrades add the missing paths one per snapshot.
  Staging gains `cofounder_responsibility_content` and
  `cofounder_responsibility_manifest` (with `p_path`).
- `20260828019500` and `20260828019600`: deletion is blocked while an agent
  is accountable for a non-retired responsibility; agent grants name
  `responsibilities` (array) instead of one department, with the creating
  agent limited to responsibilities it is accountable for or holds.
- TypeScript: `cloud-company-organization.ts` (parser and hierarchy:
  Co-Founder, then responsibilities with their accountable agent and
  sponsored projects, then rooms and staff), `cloud-company-agent.ts`,
  `company-bootstrap.ts`, `member-company-file.ts`, `app-server.ts`,
  `renderer.js`, and their tests.
- Subsidiary docs reconciled: `supabase/SESSIONS.md` (one open conversation
  per agent and audience scope, already enforced by `19000`),
  `supabase/CLOUD-CONTROL-PLANE.md` (the `department` compute-identity
  ownership label is a legacy scope key), `RUNTIME-STEP-0-ORGANIZATION.md`.

Verification (disposable PostgreSQL 17.6 in Docker, no live database):

- `node scripts/test-company-organization-kernel.mjs`: all migrations, SQL
  310 and 315 pass (commit `de3d6cd0f` and later).
- `node scripts/test-runtime-provenance.mjs`: all migrations, SQL 305, 306,
  307, 310, 315, the SQL 290 native fixtures, split owners, concurrency and
  restart pass (commit `16f23e856`).
- Focused vitest: shell 31 (organization, agent, hosted primary, company
  file), coding-agent 2, object-gateway 50 (bootstrap, member file) pass;
  `tsgo --noEmit` clean after the generated model data was restored from the
  sibling checkout (that data is gitignored and was absent in this worktree).

Proven: the responsibility model is the only organization model in the
schema and the shell; a company is created with its Co-Founder holding four
real responsibilities; ceremonial or source-less responsibilities are
rejected; responsibility ACLs fence paths by accountability and explicit
grant. Blocked: nothing in source. Needs Jonas: the contract's section 19
"Current implementation checkpoint" paragraph still describes departments
and department-scoped resources; it is contract text and was not edited.

### 2026-09-02, work block 2: Order 1 usage-limit signal, concurrency policy, ceilings (Phase A.2–A.4)

- `20260828019980_provider_usage_signals.sql`: `qorpera_provider_connection_usage_signals`
  (run, job, sponsor version, connection version, kind `usage_limit` /
  `rate_limited` / `provider_outage`, source `native_adapter`, `resets_at`),
  `qorpera_member_notifications` (one open notification per member, kind and
  dedupe key; kinds `provider_usage_limit`, `company_ceiling_tripped`),
  service-only `qorpera_record_provider_usage_signal(p_binding, kind,
  resets_at)` authorized through the run's current native lease, and
  member RPCs `qorpera_list_member_notifications` and
  `qorpera_acknowledge_member_notification`. A usage-limit signal notifies
  the connection owner (or the company's founders for a company connection)
  exactly once per open limit; replay is exact.
- `cloud-native-provider-host.ts` exports `nativeProviderUsageSignal`, which
  maps only the host's safe categories (`provider allowance` → usage limit,
  `provider capacity` → rate limited, `provider network` → outage) to typed
  signals; `cloud-native-company-runtime.ts` records the signal before the
  job fails, never retries, never masks the failure. The RPC is added to the
  closed path-control allowlist.
- `20260828019990_provider_connection_concurrency_policy.sql`: the global
  provider policy ceiling rises from 1 to 8 so a per-connection policy above
  one is admissible; the provider service consents a default of 4
  (`QORPERA_NATIVE_CONNECTION_CONCURRENCY`, 1–64). Lease acquisition still
  refuses beyond `least(version, policy)`; no credential fallback.
  `NATIVE-SUBSCRIPTION-ACCEPTANCE.md` and `STEP-2-ARCHITECTURE.md` follow.
- `20260828019995_company_execution_ceilings.sql` (contract 7.4, low
  priority): `qorpera_company_execution_ceilings` with kernel defaults
  (250 USD and 100 M tokens per month when unconfigured), founder-only
  `qorpera_set_company_execution_ceiling` with version control, member
  `qorpera_company_execution_ceiling_json`, and a replaced
  `qorpera_reserve_execution_sponsor_authority` that refuses admission for a
  sponsor without a provider-side usage wall when the period's spend or
  reserved tokens would exceed the ceiling, records
  `qorpera_company_ceiling_trips`, and notifies founders from the control
  plane. Subscription sponsors are untouched. Wake-rate ceiling and the
  founder stop remain Order 3.

Verification: `node scripts/test-runtime-observability.mjs` passes with SQL
320 extended (signal, notification, replay, privacy, concurrency policy);
shell vitest 80 pass (runtime, host, service, path control); `tsgo` clean.
SQL 330 (ceilings) is added to that driver in this block; its result is
recorded in the next entry.

### Stale draft inventory: `~/.codex/worktrees/27d4` (branch `codex/runtime-step1-cloud-mouth`)

Inventoried 2026-09-02 and left untouched; nothing was built on it.

| Item | What it is | Disposition |
| --- | --- | --- |
| `deploy/first-node/RUNTIME-STEP-2-AUDIT.md` (untracked, 458 lines, 2026-08-28) | The runtime Step 2 audit: native filesystem bypass, missing result envelope, one authoritative operation, retirement candidates, acceptance gates. | Historical. Its findings were implemented on the runtime line (`20260828004000`–`005000`, the result fence, Company File gateway) and are recorded in `RUNTIME-STEP-2-*.md`. Unique as a narrative; no source value. |
| `supabase/migrations/20260827001000`–`003000` and tests `185`–`188` (untracked) | An unshipped "multiplayer authority spine" prototype (principals, scopes, grants, actions) plus a direct Co-Founder seed and staff-dependent deletion. | Superseded by the shipped path kernel (`20260828005000`) and organization kernel (`19100`–`19600`). Never applied anywhere. Do not apply. |
| `packages/contracts/src/index.ts` (+71 lines) | Type constants for that prototype (`AUTHORITY_PRINCIPAL_KINDS`, resource scopes, permissions). | Superseded by the closed path-control and organization types on the runtime line. |
| `packages/shell/src/staff-templates.ts`, `staff-deletion.ts`, `main.ts`, `renderer.js`, `preload.cjs`, userland | A seeded Co-Founder template and a desktop-executed deletion/creation flow. | Superseded by the cloud-owned bootstrap (`19300`) and governed agent lifecycle (`19500`/`19600`). |
| `supabase/COMPANY-FILE.md` (+330 lines), `supabase/CLOUD-CONTROL-PLANE.md` (+109 lines), `STEP-3-COMPANY-COMPUTERS.md`, `README.md`, `AGENTS.md`, engine/company docs | A 2026-08-27 doc rewrite: "kernel law", three durable outcomes, pure-cloud boundary, three enforcement layers. | Its substance is now contract sections 5 and 12. The runtime branch's `COMPANY-FILE.md` keeps the shorter shipped text; nothing unique survives that the contract does not state. |
| `.artifacts/runtime-step-separation-20260828/` (gitignored) | The sealed Steps 0–2 evidence: preview/production read-only inventories, packets, signed proofs. | Authoritative evidence store; read-only. Referenced by this record. |

### Confirmations without code change

- **Gated decisions wait durably (contract 16.2, Phase A.3).** A protected
  write becomes a `qorpera_company_path_proposals` row with status `open`
  (`20260828005000_company_file_path_gateway.sql`, table at lines 125–146).
  Open proposals have no expiry and no purge or retention path deletes them
  (no migration deletes from that table). Only an approval carries a
  ten-minute window: the approving member must apply within it, an expired
  or foreign approval cannot be reused, and a skip withdraws an unexecuted
  approval and returns the proposal to `open` for any authorized member
  (`qorpera_review_company_path_proposal`, lines 955–975;
  `qorpera_company_path_approved_actor`, line 1008). The run that raised the
  proposal completes with a `proposed` outcome; nothing blocks the agent's
  other work on it. Until a phone or web approvals surface exists
  the desktop client is the approvals window. No change was needed.
- **Sessions (contract 23, Phase A.4).** No session code was touched. One
  open conversation per agent and audience scope is already enforced by
  `20260828019000_member_private_staff_sessions.sql` (two partial unique
  indexes); `supabase/SESSIONS.md` now says so.

### Follow-ups recorded, not done here

- The legacy free-text `department_id` on `qorpera_profile_staff`
  (`20260816005000`, production-applied) and the `department` compute-identity
  ownership label (`20260821001000`, production-applied, unused) are not
  organization objects; renaming them is a later forward migration.
- The desktop's local product-development kits under
  `departments/<id>-development/` (`packages/coding-agent/src/core/company.ts`,
  the path-protection rule in `20260828005000` line 713 and `19950` line 33)
  and the desktop "Add department" navigation-group wizard are the legacy
  local layout and UI, not the organization model. The production Company
  File has no such folder. Renaming them touches on-disk layout and the
  frozen Staff Shell specification; it is a separate bounded rename for the
  founder to schedule.
- A desktop surface that lists and acknowledges member notifications
  (`qorpera_list_member_notifications`) and shows the company ceiling
  (`qorpera_company_execution_ceiling_json`) is client work; the control-plane
  records and RPCs exist and are tested.
- Automatic same-principal sponsor handoff (contract 17, acceptance 29) is
  Order 3 and reads the usage signals recorded here.

### 2026-09-02, closing verification for Phase A

All checks ran on this worktree against disposable PostgreSQL 17.6 in Docker;
no live database, provider, credential, signing, release or production
operation was performed.

- `npm run check`: formatting, runtime-bundle freshness, pinned dependencies,
  import and cloud-boundary checks, shrinkwrap, install lock, `tsgo --noEmit`
  and browser smoke pass. Generated bundle `70128b6938627f302e4b48b789bcd168ea742adbcfb07dd984f586fa6cdcf875`
  (manifest, compiled constants and source-only `19900` activation committed).
- `node scripts/test-runtime-observability.mjs`: all 110 migrations, upgrade
  with admitted history, member-authority OID/owner/ACL preservation, SQL
  290, 320 (with the usage-signal, notification and concurrency cases), 306,
  321 and 330 pass.
- `node scripts/test-runtime-provenance.mjs` and
  `node scripts/test-company-organization-kernel.mjs`: pass (recorded above).
- The repository's all-suites driver (`scripts/test-hosted-db.mjs`, run as a
  copy that skips three suites): 110 migrations and 43 suites pass,
  including every Orders 0–2 suite (290–330). Suites `100_session_arbiter`,
  `140_cloud_company_authority` and `280_cloud_session_run_control` fail
  with the same assertions on the untouched base commit `5a3c72890` (run in a
  throwaway worktree); they predate this session, were not part of any
  closeout gate, and are legacy session/run suites superseded by the Step 1–2
  migrations. They are not fixed here.
- Focused vitest: shell 111 (organization, agent, hosted primary, company
  file, native runtime, host, provider service, path control), coding-agent
  2, object-gateway 50 pass.

Commits on `codex/steps-0-2-fable-handoff`: `9bd09d8f3`, `de3d6cd0f`,
`f84fc81a9`, `16f23e856`, `b2a579a42`, `f32516863`, `c8764cffe`,
`c03ae4ef5` (43 files, +2431/−688 against `5a3c72890`). The branch is local
only and has not been pushed.

**Proven (source and disposable database):** the responsibility model is the
only organization model; a new company is created with its Co-Founder holding
four real responsibilities; ceremonial responsibilities and absent sources are
rejected; responsibility and project ACLs fence paths; typed usage signals
are recorded against exact sponsor and connection versions and notify the
connection owner once; the per-connection concurrency policy admits more than
one run; company spend and token ceilings refuse API-billed admission with
trip evidence and founder notification; gated decisions already wait durably
in open proposals.

**Blocked:** nothing in source for Phase A. Phase B has not started; its
gates are the closeout's remaining closure gates, now against this candidate.

**Needs Jonas:** (1) approve this branch as the clean candidate for Phase B,
or ask for changes first; (2) decide whether to push the branch to the shared
remote; (3) approve editing the contract's section 19 checkpoint paragraph
that still describes departments; (4) decide whether the legacy local
product-kit `departments/` folders and the desktop "Add department" wizard
are renamed now or later (see follow-ups above).
