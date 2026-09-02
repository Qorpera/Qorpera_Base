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
  provider policy ceiling rises from 1 to the schema maximum of 64, and the
  provider service consents that maximum by default
  (`QORPERA_NATIVE_CONNECTION_CONCURRENCY`, 1–64, lowers it). Founder decision
  2026-09-02: uncapped by default; the provider's quota is the real ceiling.
  Lease acquisition still refuses beyond `least(version, policy)`; no
  credential fallback.
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

## Phase B, gate 1: candidate frozen, packages rebuilt, rollout packet v3 rehearsed (2026-09-02)

Founder decisions 2026-09-02: the per-connection concurrency policy is
uncapped by default (commit `ebbd1e734`), the branch is approved as the
candidate, and it is pushed to `origin/codex/steps-0-2-fable-handoff`.

**Candidate.** Commit `ebbd1e734655beece97ddda0828d11b95e6cb3dc`, runtime
bundle `25cdf35e6daed70dbe7912709bf136e4873af2107be078bcb5386c7f7d75bf5e`.
Later commits on the branch are records only and do not change the bundle
closure; signing and packaging reference this exact commit.

**Rebuilt packages (macOS, unsigned, from that tree).** Guest package
manifest `9dbc6471d370025aa96eb1e6405732d0a3b4ec08f32212b272dd959747b52187`,
guest archive `lxd-runner-guest-ebbd1e734.tar.gz`
`287a3748555e25c6aad751d9d5cc5c1e5fa1c3b6ab675da7d109b6b0c44790d1`
(repacked 2026-09-02 with the package contents at the archive root and no
macOS metadata; an earlier archive `8612464d…` had the wrong layout and was
rejected by the node recipe before any build); LXD
provider manifest `6977f3c1dea9d6f76f3cb68eb7180ead5bc37cf3cdb78943e2192354471ab465`;
Runner Orchestrator manifest `fbf8952dbfed5f4b541163d7f7a0001b0455dec5154249a7c072c45b30edb022`
(unchanged from the production pin); cloud secret broker manifest
`327efc5565284c0af1676558f63babbaa6b1ec64f6d9d226652b3c80ccb807e0`;
ephemeral runner manifest `d9fcfb85a7a52f47fab94b576d3de63beb37afa89d8958ab9feb719237425d50`.
The native binary (`2f2c26cf…`, the bundle's pin), runner OCI archive
(`c9370c82…`) and Cosign bundle (`98a00fef…`) were reused unchanged from the
retained a535c773d guest package and re-verified by the packager.

**Rollout packet v3.** Successor of the 2026-09-01 v2 packet for this
candidate: 36 ordered source files (`20260828004000`–`20260828019995`, stage
B now 25), 41 steps, packet `cc4ff5d908276ef5891ffc848fc5f7cd6dd74efdfb547bd99b074740fa73819a`,
frozen manifest `bae11a1257ca913b8e86e2f8fd86856fa5a9be9e49e1febe544a6a045cd7009a`.
Its 96 focused tests pass. The wrapper rehearsal against the captured
production schema (`aa4c1baf…`, 2026-08-29) in a network-disabled PostgreSQL
17 container passed all 41 steps: final ledger 128 with the 18
production-only versions retained, global OpenAI policy disabled at version 3
with the uncapped concurrency ceiling, the existing company's bootstrap job
queued with its four minted Co-Founder responsibilities and not executed,
admission not reopened. Dispatch stays disabled. Before any dispatch: a
fresh read-only production preflight (the last live inventory is the
2026-08-31 baseline) and a re-pinned Supabase CLI (the v2 pinned binary no
longer exists locally).

Evidence: `~/.codex/worktrees/27d4/Qorpera_Base-step2/.artifacts/runtime-step-separation-20260828/step2/verification/steps02-phase-b-gate1-20260902.fable/`
(packet, rehearsal proof and cleanup, packages, input checksums, and
`build-lxd-runner-image-candidate-ebbd1e734.sh`, the node build recipe with
this candidate's pins); its `SHA256SUMS` has SHA-256
`250809c7a96e0f677ee9f133da58f5c581c9f27ff6270eb86d496f4e3785c799`.

**Node findings (read-only, 2026-09-02 23:18 UTC).** `company41-node-01` is
reachable over Tailscale as `company41-admin`; sudo requires an interactive
password, so the LXD socket, the image build and the clean-boot verifier
cannot be driven from this session. The root filesystem had 2.9 GiB free
(97% used); an image build needs more. Provider and orchestrator services
are disabled and inactive.

Note for dispatch: the packet's source check requires the runtime worktree
to be at commit `ebbd1e734` with a clean tree; later record commits on the
branch mean that commit must be checked out (detached) before
`controller.mjs check` or any dispatch.

**Proven:** the candidate's packages and the production SQL delta are
reproducible from the pushed commit and rehearse cleanly against the captured
production schema. **Blocked:** the signed image and clean-boot proof (node
sudo and disk), the isolated cloud acceptance (an isolated environment and
the retained acceptance VM, which cost money to start), and dispatch (fresh
preflight, CLI pin, and the two approvals in the production record).
**Needs Jonas:** (1) free disk on the node and either run the build recipe,
verifier, signing and public-key install with me on the line, or grant the
session passwordless sudo for those exact commands; (2) approve starting the
retained acceptance environment for gate 2 with its cost; (3) when ready for
gate 4, approve the read-only production preflight.

## Phase B, gate 1 closed: image built, clean boot accepted, provenance signed and staged (2026-09-02)

Founder decision 2026-09-02: delete the old v48–v54 archives on the node and
take whatever further actions the task needs. The node's sudoers already
granted passwordless root for the exact build, verify and activate script
paths, so the candidate recipe and verifier were installed at those paths and
run through them (previous recipe kept as
`build-lxd-runner-image-candidate.v47-recipe-backup.sh`).

**Node cleanup.** Deleted the v48–v54 guest archives (23 files, about
2.7 GB; checksums in the evidence) and the superseded unsigned candidate
images v37–v45 from LXD (about 19.5 GB), keeping v46, v47, the two signed
candidates and all Step 3 images. Root volume: 2.9 GiB free before, 22 GiB
free after gate 1 (the image build itself used about 2 GiB). Larger cleanup
needs root beyond the sudoers rule: about 300 GB of the volume group is
unallocated (the root logical volume is 100 GB; the LXD pool has 1.32 TiB
with 111 GiB used) and a root-owned 2.3 GB `/tmp/qorpera-azure-step2-v52.tar.gz`
sits on the root volume.

**Image.** Built 2026-09-02 00:09 UTC from guest archive `287a3748…` and
manifest `9dbc6471…` on base `5e644ada…`: LXD fingerprint
`c1b81ab6ed63004257a2a226b349ca2e7a1f3db552dae7a69e46baf0c6df212b`, alias
`qorpera-runner-25cdf35e-ebbd1e73-candidate-unsigned`, 2153.92 MiB.

**Clean boot.** The pinned verifier booted the image as a KVM virtual
machine under UEFI Secure Boot with no credentials and no identity volume and
confirmed the fail-closed no-job boot; it accepted the fingerprint twice.
Run 1 (00:10 UTC) is kept as history only: its state log carried the label
`package_archive_sha256=8612464d…`, copied from a stale pin in the verifier
template (a label, not a check). The template was corrected, the verifier
reinstalled (`73a832e2…`) and run 2 (00:15 UTC) accepted the same fingerprint
with a correct log. The clean-boot evidence file has SHA-256
`65e6bfb2c791df6127859fc31a861a8e01606ceeff2bd078a70604ccadf93ed5`
(tested at `2026-09-02T00:15:23Z`). Both acceptance instances were deleted by
the verifier.

**Signed provenance.** Statement and envelope created for that fingerprint,
manifest, runner image, source commit `ebbd1e734` (clean tree) and the run-2
evidence hash; signed off-node with the Company 41 image-provenance key
(ed25519, key id `51f82af4…`, public key `b62d24b8…`), passphrase from the
macOS Keychain over stdin only. Envelope SHA-256
`63b05d642c02893955da34d4edc97a35f9253c7bb23702e0ca975a73f14119d2`; verified
locally and on the node with the rebuilt provider tool `316006eb…` (identical
to the installed one). The envelope, public key and tool are staged on the
node under `/home/company41-admin/step2-lxd/` with the `-ebbd1e734` suffix.
Not activated: the provider and orchestrator stay disabled and v47 remains the
active image; activation belongs to a later gate.

Evidence: the gate 1 directory (`node-image-build/`, `node-clean-boot/`,
`node-clean-boot-run1-stale-archive-label/`, `signed-provenance/`,
`runbooks/`, deletion records); its re-sealed `SHA256SUMS` (213 files) has
SHA-256 `3a820c8f2ba008761a982033e1a359369102496ea9f18e136b31153560f17cbb`.

**Gate 2 inputs checked.** The Supabase management token in the Keychain
returns HTTP 401 (expired). The Azure secret-broker VM is deallocated. No
Supabase CLI is installed locally, so the dispatch pin must be re-created.

**Proven:** the approved candidate's guest image exists on the node, booted
clean under Secure Boot without credentials, and carries signed provenance
bound to that boot's evidence. **Blocked:** gate 2 (a fresh isolated Supabase
environment with the 110-migration chain and bundle `25cdf35e…` activated, the
broker VM resumed with new transport keys, two managed members and one native
agent with every member device offline) and everything after it. **Needs
Jonas:** (1) a fresh Supabase management token for creating the isolated
environment; (2) a go for resuming the broker VM and any acceptance hosts,
with their running cost; (3) later, the read-only production preflight and
the CLI re-pin before dispatch, and the activation approval for the signed
image.

## Phase B, gate 2 opened: node storage facts, broker resumed (2026-09-02)

Founder message 2026-09-02: expects at least 1 TB of cleanup on the node,
asks how much node storage could live in the Company File on the NAS, asks
for the broker VM to be resumed, and will supply a fresh Supabase token.

**Node storage, measured.** One 1.8 TiB NVMe drive: a 100 GiB root volume,
a 1.4 TiB LXD ZFS pool, and about 300 GiB left unallocated in the volume
group. The pool held 111 GiB before this block and 102 GiB after; it is not
short of space. The root volume was the only tight one, and its main consumer
is LXD's image store on the root filesystem (23 images, 49.7 GiB before this
block). There is no 1 TB of removable data; the drive is mostly free space
already. No network filesystem is mounted on the node.

**Deleted (same class as the founder-approved v37–v45 deletion).** Twelve
unsigned, superseded runner candidate images: v48–v56 and the three
superseded commit candidates `dbc645eee`, `48b794a36`, `2e1493aec` (about
27 GiB; fingerprints and sizes in the gate 2 evidence file
`node-superseded-image-deletion.txt`). Kept: the signed v46 and v47 images,
the signed `ce5d96434` and `363e295a` candidates, this candidate `c1b81ab6`,
the base image, the Ubuntu 24.04 container image, and the four Step 3
Company Computer images. Root volume: 22 GiB free before, 49 GiB free after
(48% used). The 57 stopped LXD instances (old runner, build, package,
acceptance, custody and login VMs) live in the pool, not the root volume;
some are retained proof VMs, so none were deleted. The remaining root-only
fixes need real root: extend the root volume into the unallocated 300 GiB,
and delete the root-owned 2.3 GB `/tmp/qorpera-azure-step2-v52.tar.gz`.

**Broker VM resumed.** `vm-qorpera-s2-secret-01` (Standard_F1as_v7,
Trusted Launch) went from deallocated to running at about 00:23 UTC; before
and after views are in the gate 2 evidence (`azure-before-resume.json`,
`azure-after-resume.json`). Its daily auto-shutdown at 23:00 UTC is enabled,
so it deallocates itself tonight unless the proof is running. No ingress
rule, public IP or disk was created.

**Gate 2 toolkit located.** The previous proofs' operator sets are sealed
under the 27d4 worktree's artifacts (`current-candidate-cloud-proof-20260830.*/operators-current/`
and the 2026-08-31 joint record). They pin the retired preview
`tlnzirrtjufnexorsbic`, its synthetic company and the old commit and bundle,
so they are a reference, not something to replay: the gate 2 driver must be
re-pinned to a fresh isolated environment, commit `ebbd1e734` and bundle
`25cdf35e…`. The isolated environment itself needs a valid Supabase
management token; the Keychain one returns HTTP 401.

Evidence: `steps02-phase-b-gate2-20260902.fable/` next to the gate 1
directory (not yet sealed; sealed when gate 2 closes).

**Proven:** the node has ample space overall and a healthy root volume; the
broker is running. **Blocked:** the isolated environment (token). **Needs
Jonas:** the fresh Supabase management token; a decision on extending the
root volume (a one-line root command on the node); a decision on the Step 3
v1/v2 Company Computer images (11 GiB) and the stopped proof VMs.

**Root volume extended (founder, 2026-09-02 ~00:45 UTC).** Jonas ran the
root extension and the tarball removal on the node himself through ssh and
sudo. Verified afterwards: root volume 295 GB with 238 GB free (16% used),
logical volume 300 GiB, `/tmp/qorpera-azure-step2-v52.tar.gz` gone; the LXD
pool is unchanged at 102 GiB used of 1.32 TiB. About 100 GiB of the volume
group remains unallocated for later. The node's image store is no longer a
constraint on builds.

**Isolated environment created (2026-09-02 01:02 UTC).** The Keychain's
2026-08-23 management token is expired, but the CLI's own login token from
2026-08-24 (Keychain item "Supabase CLI") is valid and was used; Jonas can
revoke it and issue a dedicated one at any time. The isolated environment is,
as in August, a preview branch of the production project: branch
`steps02-ebbd1e734-20260902` (id `2824a37a-cfa1-4e13-8afe-7eb58b322fc5`,
ref `cmydwcnarpusaxsplctt`, `with_data: false`, non-persistent), healthy
about 20 seconds after creation. Two August branches still exist on the
project (`step2-fences-v48-20260828`, `step2-secret-custody-20260829c`) at
roughly $10 a month each; not touched.

Supabase creates a branch with the parent's schema and migration ledger as
of the default branch's registration (2026-08-28 10:30 UTC): 88 records,
including 16 of the 18 production-only versions. Missing were the two later
production-only records `20260827045000 mobile_push_dispatch` and
`20260827046000 mobile_push_dispatch_activation`, whose SQL exists only in
production (the August read-only reads captured names, not statements), and
the two shared files `20260828002000` and `20260828003000`. The pinned CLI
2.115.0 (`supabase.js` `21d25b4b…`) refused `db push` because of the
remote-only versions and proposed marking them reverted; that was not done,
on the branch or anywhere else. Instead a small runner (`runbooks/migrate-branch.mjs`
in the gate 2 evidence) applied the 38 source files `20260828002000` through
`20260828019995` in version order, one serializable transaction per file
with the packet's ledger-row form (version, name, statements = the source
bytes), and recorded each step. Result: 38/38 passed, ledger 88 → 126, all
16 production-only rows retained, the two mobile-push records absent by
necessity (they are unrelated to Orders 0–2 and were also absent from the
August preview). The 36 candidate files match the rollout packet's pinned
hashes byte for byte. The read-only verification before and after is in
`preview-branch-verify-initial.json` and `preview-branch-verify-migrated.json`.

**Gateway and company on the isolated branch (2026-09-02 01:13–01:21 UTC).**
Proof id `f3933956-f53e-4ffe-bfdb-0efed53cc1e6`. A fresh gateway VM
`qorpera-gateway-ebbd1e734` (LXD project default, network `qorpera0`,
10.41.0.221) was created from the base image with Node 22 from the Ubuntu
archive, exactly as the guest contract installs it. The object gateway was
bundled from the candidate source (17 inputs identical to `ebbd1e734`,
artifact `090dd9a9…`) and installed with the August proof's hardened units
and initializer, re-pinned to the branch; the branch keys reached the VM only
as ciphertext for the VM's own transport key. The gateway reports healthy
against the branch on 127.0.0.1:8090 with its native-only TLS front on
10.41.0.221:9444 (CA `379bdc91…`). Two fresh-VM differences were fixed on the
spot: the hardening's inaccessible paths must exist, and the install
directory must be world-readable for the service user.

The proof owner (a managed Auth user, password only in the macOS Keychain)
created company `391f4bad-18e9-4e30-a601-8dfbf98531ef` through
`qorpera_create_cloud_company` (contract version 2). The gateway's bootstrap
worker claimed and completed the job at 01:20:30 UTC: Company File `ready`,
path gateway version 1, and the organization JSON lists the Co-Founder's four
company-level responsibilities `direction`, `founder-relationship`,
`resourcing` and `responsibility-map`, all active with one measure each. This
is the first live genesis under the responsibility model (Phase A.1) and the
first live run of the v3 bootstrap worker on the candidate bundle. Evidence:
`company-bootstrap.json`, `gateway-installed.json`, `gateway-*-check*.txt`
in the gate 2 directory.

**Gate 2 checkpoint (2026-09-02 01:45 UTC) and what remains.** Done on the
branch and the node without founder involvement: isolated branch at the
candidate schema and bundle, gateway VM serving the branch, company genesis
under the responsibility model, rebuilt provider, runner and secret-canary
packages staged (canary manifest `770dac75…`, built from the candidate). The
rest of gate 2 is the native path and the custody path, in this order:

1. Broker on Azure: re-point the retained broker VM's encrypted database and
   configuration credentials to the branch (new dedicated broker login on the
   branch, new proof TLS CA, temporary public IP and a source-restricted
   ingress rule for the node's egress address), install the rebuilt canary
   package as a new content-addressed root next to the retained one, and
   re-point the identity-recovery authority on the same VM. This changes
   retained infrastructure and needs an explicit go.
2. Isolated provider on the node: the rebuilt provider needs the LXD socket
   (root or the `lxd` group), which the session's sudo rule does not grant.
   Needs either a one-line sudoers rule for a launcher script or the founder
   running the launcher.
3. Native login: the provider creates the login guest from the signed image,
   and a member completes the provider's device login in a browser with the
   approved test account. Needs the founder at the keyboard for a few minutes.
4. Native host guest from the signed image with the identity volume, the
   two-member joint proof with every member device offline, non-exposure
   scans, cleanup and sealing.

Nothing on the retained broker VM was changed; it stays running until its
23:00 UTC auto-shutdown. The two August preview branches were not touched.

**Broker re-point (founder go 2026-09-02, executed 01:25–01:45 UTC).** Every
change on the retained VM `vm-qorpera-s2-secret-01` went through Azure
RunCommand as a public operator with an embedded checksum; each operator and
its result are in the gate 2 `broker/` evidence. Read-only inventory first:
all four services inactive after the resume, package link on the August root
`…-manifest-1f39ab0ef73e7852`, fifteen encrypted credentials, database
credential on the pooler's transaction port for the old preview, recovery
config bound to the old company and preview.

Branch side: the `qorpera_secret_broker` role got a login (LOGIN, NOINHERIT,
no elevated attribute, no table grant, exactly three executable functions;
password only in the macOS Keychain). The retained broker authority
`c571dd3e…` (key `company-kek-2`) and recovery authority `a575103b…` were
enrolled for the proof company at origin `https://4.165.129.38:8443` using
capability hashes and public keys derived on the VM from its own credentials
(values never left the VM); the branch's registration RPC returns the
enrolled recovery keys.

VM side: (1) a proof transport key was generated on the VM and the new
database credential, recovery config (new company and branch, journal and
NAS fields carried over) and branch service key were delivered as ciphertext
for it; the three encrypted credentials were rewritten with `systemd-creds`
and their previous encrypted files retained under
`/etc/credstore.encrypted/retained-f3933956…/`; the config, control, runtime,
keyring and canary credentials are unchanged. (2) The rebuilt secret-canary
package (manifest `770dac75…`, broker `b15a6d1e…`) was installed as a new
content-addressed root next to the retained August root and the package link
switched. (3) A per-proof CA and certificate (CA `6908c751…`) front the
broker and the recovery routes on 8443 through a transient hardened proxy
unit; destination, broker and proxy are running. (4) Azure: public IP
`pip-qorpera-s2-secret-proof` = 4.165.129.38 attached to the VM's NIC and one
NSG rule from the node's egress 2.110.77.200/32 to 10.80.1.4:8443. From the
node and from the gateway VM, an unauthenticated call with the proof CA gets
404 as in August, and without the CA the TLS handshake is refused.

Two fresh-VM lessons were recorded: the RunCommand wrapper's umask 077 leaves
new directories unreadable to service users (fixed with explicit modes), and
the recovery authority needs its journal directory and the localhost NAS
export and mount, both retired with the v56 proof.

**Recovery authority restored (01:46 UTC).** The journal directory was
created on the mounted 32 GB journal disk, the retired localhost NFS export
was re-enabled from its kept v56 definition under a proof-named file in
`/etc/exports.d/`, and the NAS was mounted at runtime with the retired
options (no fstab change, so a reboot returns the VM to its retained state).
`qorpera-identity-recovery.service` is running on 127.0.0.1:18081 and
reachable through the same 8443 front. **Proven:** the retained broker VM
now serves the isolated branch for both custody and identity recovery, with
every prior encrypted credential and the August package root retained.
**Blocked:** the isolated provider on the node (sudo) and the native login
(founder with the test account). The broker VM still deallocates itself at
23:00 UTC; the proof route (public IP and NSG rule) must be removed at
cleanup.

**Isolated provider on the node without a sudo change (01:50–01:58 UTC).**
The August v48 acceptance had solved the socket problem already: a private
LXD transport in the admin's home exposes an LXD-API-shaped Unix socket and
forwards only an exact allowlist of operations through the existing
`sudo -n lxc` rule, so the provider runs as `company41-admin`. That transport
was re-pinned to this proof (root `step2-lxd/steps02-gate2-ebbd1e734`,
project `qorpera-step2-v48`, image `c1b81ab6…`, login guests
`qorpera-login-<identity>`, identity volumes `step2-identity-<identity>`, the
three guest commands the provider issues, bootstrap file paths only). The
rebuilt provider (`767e5d2b…`) runs from that root with the signed
provenance, the branch keys, the gateway's native-object token, the broker
CA and the broker runtime token, which reached the node only as ciphertext
for a node-side transport key generated for this proof. Its API binds to
127.0.0.1:28081 with a proof-local certificate (the production certificate is
root-only) and its login gateway to 127.0.0.1:28082; both answer healthy.
The launcher `run-proof-provider-ebbd1e734.sh start|stop|status|logs` is in
the proof root and in the gate 2 `runbooks/provider/`. The prepared sudoers
line is therefore not needed and was not added.

**Native login reached the device step (02:00 UTC).** The login driver set
the branch's OpenAI native-subscription policy (enabled, uncapped at 64),
created the proof compute identity `efa73215-6ba6-49c8-862f-9fafc0113916`
as the owner with the client's capability list, began login
`cbeec5fd-c523-4414-a9f1-138d1c0ca478` and handed the session to the proof
provider's login gateway. The provider created identity volume
`step2-identity-efa73215…`, launched login guest
`qorpera-login-efa732156ba649c8862f9fafc0113916` from the signed image
(10.41.0.45), pushed the bootstrap files, waited for the guest, and the
guest's login provider host returned status `awaiting_member` with the
OpenAI device URL and a user code. The founder was asked to complete the
device login with the approved test account before 02:14 UTC; a poller
watches the gateway for completion.

**Native login completed (02:19:03 UTC).** The first attempt failed at the
guest's harness-completion stage: the guest host allows ten minutes from
issuing the device code, and the founder's entry landed as that deadline
fired at 02:10:04; the poller's re-posts also made the provider re-run the
guest bootstrap every 20 seconds, which was harmless but noisy. The second
attempt (login `e836ccec-d2b4-4360-9988-0782d7fd8e7e`, code issued 02:15:41,
watched read-only on the cloud row instead of re-posting) completed at
02:19:03: credential capsule `fde29659-bc94-4f08-a71f-ebb41662834b` active
for compute identity `efa73215…`, identity backup receipt revision 1 verified
through the recovery authority on the broker VM at 02:19:03.412, one provider
connection created, and the provider stopped the login guest after observing
completion. This is the first native login of this candidate through the
rebuilt provider and the re-pointed broker VM.

**Native host guest running (02:21 UTC).** After the provider stopped the
login guest, the identity volume `step2-identity-efa73215…` (holding the
master key from the login) was moved to a persistent native host guest
`qorpera-custody-ebbd1e734` created from the signed image `c1b81ab6…` in
project `qorpera-step2-v48` (10.41.0.46), together with a fresh recovery
volume for the runner home. The guest-side provisioning (the August operator
re-pinned to this candidate: provider host `591af40b…`, fenced Codex
`2f2c26cf…`, host unit `23ec747b…`) verified both virtiofs mounts and the
private credentials, confirmed the identity epoch and key against the
cloud's recovery authority, wrote the private native-provider environment
(gateway `https://10.41.0.221:9444`, broker `https://4.165.129.38:8443`,
both CAs), and started `qorpera-native-company-host.service`, which is
active. One detail cost a retry: the relayed runtime token carried a trailing
newline and the guest requires the bare token.

**Sponsor binding and joint harness (02:24–02:26 UTC).** The owner created
execution sponsor binding `60f9e649-6965-46ea-8775-47555a4b92f5` (version 1)
on the login's provider connection `0eb98387…` version 1 (autonomous runs
not allowed by that version, so the binding was created without them). The
August joint-proof driver was re-pinned to this proof (branch, gateway host,
company, environment, Co-Founder `40496d30…`, owner, sponsor, identity,
proof-named root and socket; no stale pin remains) and launched as the same
hardened transient unit on the gateway VM.

**Joint harness ready (02:35 UTC).** Three launch corrections were needed
and are recorded: the August unit's home-protection option made `/root`
read-only on this fresh VM even with explicit write paths, so it was dropped
while the strict system protection and the write-path list were kept; the
harness's credential validator required 16 characters and this branch's Auth
issues 12-character refresh tokens, so that one minimum was lowered to 8 for
refresh tokens only; and the first failed attempt's cleanup had banned the
proof owner, who was un-banned through the Auth admin API before the retry.
The harness then passed setup: two managed members A and B created, invited
by the owner as admins and accepted, distinct private sessions with the
Co-Founder, ten fixtures published through the member API, grants issued,
both members reading the shared fixture, and each member denied the other's
private files. Coverage: managed invite/accept passed, private session
isolation passed, fixture publication and human readback passed; the native
parts are marked as requiring the external controller, which is the next
step. Status in `joint/harness-ready-status.json`.

**Custody chain for the protected effect (02:36–02:43 UTC).** The canary
connector operation `step2_canary/record_marker` (tool
`step2_canary_record_marker`, destination `https://127.0.0.1:9443` on the
broker VM, adapter `68005807…`) was registered on the branch. Actor A, the
managed admin created by the harness, obtained an independent session
through an admin-generated magic link (no email, no harness token) and began
a company-owned secret capture `proof_f3933956` for that connector; the
capture ticket, encrypted to the broker VM's transport key, was completed on
the VM by the August completion operator re-pinned to this proof (one August
pin dropped: it required the recovery authority to be inactive, and here it
runs by design). Secret `715a6ea9…` version 1 is active in the broker's
custody with the VM's encrypted credentials and destination ledger unchanged.
Two more branch-specific corrections: the operator's refresh-token minimum
was lowered to 8 like the harness's.

**Turn sponsor finding and harness cycle (02:43–02:45 UTC).** Actor A's turn
request in the August form (`company_connection` sponsor mode) was refused by
the cloud with "company session turn requires a company connection": the
login had produced a member-owned provider connection and a member sponsor
binding, and the current source creates company-level identities and
connections only through fixtures, never through a member RPC. The August
proof relied on such a fixture identity. The faithful product path is that a
member runs the native agent on their own subscription connection, so actor
A must hold their own login. The harness was extended so a turn may name its
sponsor mode, binding and compute identity, and a member-side operator was
written that acts as actor A through an admin-generated magic link to create
A's identity, begin A's login and bind A's sponsor. The first harness was
finished cleanly (its own result: setup passed, cleanup passed, harness
passed, stop reason finish; kept as attempt 2); its cleanup bans the fixture
owner, so the owner was un-banned again before the restart.

**Actor A's own native login (02:47–02:55 UTC).** With the harness restarted
under fixture prefix `step02-joint-f3933956-r3` (A `a512a7ac…`, B
`c5e43a9a…`, deadline 03:31 UTC), actor A created their member compute
identity `3c0a7a8f…` and began a login through the magic-link operator; the
provider launched A's login guest from the signed image. The first attempt
failed at the guest's completion stage with a plain error seconds after the
founder's confirmation; a second login on the same identity (the member
identity is one per member, so the operator reuses it) completed at
02:55:25: capsule `18d45dd3…` active, provider connection `0398405a…`
owned by A, version 1 active. The founder entered three device codes in
total tonight for the two identities.

**Real control-plane chain instead of an operator-driven admission (02:58–03:14 UTC).**
Actor A's turn was queued with A's own sponsor binding `182add97…` and
identity `3c0a7a8f…` (sponsor mode `member_connection`). Nothing on the branch
materializes queued turns by itself (no scheduler), and the August record
did it as the deployment administrator through the same functions the
orchestrator uses. This time the real chain runs: the rebuilt runner
orchestrator (`lxd-steps02-gate2`, registered on the branch as
`48392582…`) runs on the node as the admin user beside the provider, drives
the runner-orchestrator edge function (deployed on the branch, needing only
its Supabase secrets), claims the job, and asks the provider for a runner;
the provider creates the job guest `qorpera-<run>` from the signed image with
A's identity volume, a fresh recovery volume and the filtered NIC, pushes the
bootstrap material, and starts the guest. Three corrections on the way, all
in proof tooling, not in the runtime: the transport shim's NIC check sorted
its key list in place (the first two jobs failed their eight dispatches on
that); the provider's cloud-secret CA file must bundle the gateway CA with
the broker CA, since job guests verify the gateway through it (the third
job's guest bootstrapped and failed on the gateway's TLS); and a guest whose
bootstrap failed keeps A's identity volume attached, so it was stopped,
journaled and deleted before the next dispatch. The hand-provisioned native
host from earlier was stopped and released A's volume; it is no longer part
of the run path.

**Candidate defect found by the real job path (03:17 UTC).** With the CA
bundle in place, the fourth run's guest `qorpera-c89a1772…` still failed its
bootstrap with a bare "fetch failed". The cause is in the candidate's guest
package, not in the proof tooling: the unit `qorpera-lxd-runner-bootstrap.service`
carries `RestrictAddressFamilies=AF_UNIX`, so the bootstrap cannot open any
network socket, while under the company-path runtime it must call the cloud
for the identity's recovery epoch before it can start the runner. The login
bootstrap unit, which also calls the cloud, does not carry that restriction
and worked all night. Run once by hand inside the guest without the sandbox
(a diagnostic replay of the same script, nothing else changed), the bootstrap
completed, the runner activated itself in the cloud (runner `a5dcbe32…`,
active at 03:17:35) and both `qorpera-company-runner.service` and
`qorpera-native-company-host.service` came up. This must be fixed in source
(allow AF_INET and AF_INET6 for that unit, or move the epoch check) before
the candidate can be released; the proof continues on this guest to see how
far the run gets.

**Gate 2 closing position for 2026-09-02 (03:25 UTC).** The proof was
stopped at the job guest because the candidate's runner-bootstrap unit
cannot reach the network under its own sandbox, and a provider that starts a
fresh acquisition cannot adopt a guest that was bootstrapped by hand. The
harness was finished cleanly (its own result: setup passed, cleanup passed,
harness passed, four turn requests recorded; kept under `joint/harness-r3/`);
the job guest `qorpera-c89a1772…` is stopped and kept with its journal; the
provider, transport and orchestrator are stopped on the node; the Azure
ingress rule and the proof public IP are removed (the VM keeps its re-pointed
credentials and the new package root, and deallocates itself at 23:00 UTC);
the branch, the gateway VM and the login guests remain for the follow-up.

**Proven live on the candidate tonight:** responsibility-model genesis
through the v3 bootstrap worker; native login through the rebuilt provider
for two identities with the identity backup verified by the recovery
authority on the re-pointed broker VM; two managed members with private
sessions, fixtures, grants and cross-member denials; company-owned secret
capture and grant through the broker; a member's sponsored turn accepted by
the cloud; the orchestrator and provider chain materializing the turn,
claiming the job and launching the job guest from the signed image on the
member's identity volume.

**Blocked:** the native execution, protected effect, review, revocation and
member-removal steps, the scans and the seal, all behind the bootstrap unit
defect. **Needs Jonas:** (1) decide the fix for `qorpera-lxd-runner-bootstrap.service`
(allow AF_INET and AF_INET6 like the login unit, or move the recovery epoch
check); it changes the guest package and therefore requires a new candidate
commit, a rebuilt and re-signed image and a repeat of gate 1; (2) the two
August preview branches and this branch each cost about $10 a month while
they exist.

Evidence for gate 2 is in `steps02-phase-b-gate2-20260902.fable/` next to
the gate 1 directory (broker operators and results, provider and joint
runbooks, harness results, job-guest journals, Azure before/after views);
its `SHA256SUMS` (316 files) has SHA-256
`ad9e3b3ea74f14eb3a18ac89fa4533b64c23db66d32f56afc1fca172f4f6dfaa`.

**August preview branches deleted (founder decision, 2026-09-02 03:40 UTC).**
`step2-fences-v48-20260828` (`hurfdoempkqpzxggemhc`) and
`step2-secret-custody-20260829c` (`tlnzirrtjufnexorsbic`) were deleted
through the management API (both HTTP 200). Their proofs stay as the sealed
August records on the founder's Mac; nothing in this session or the
production packet referenced the live branches. Only `main` and tonight's
`steps02-ebbd1e734-20260902` remain on the production project.

## Candidate 2: bootstrap unit fix and rebuild (founder decision, 2026-09-02 03:45 UTC)

Commit `7c8e69d056431867fbf10b41430003dfabe4dda8` on the same branch changes
one line of the guest contract: `qorpera-lxd-runner-bootstrap.service` now
allows `AF_UNIX AF_INET AF_INET6`, matching the login bootstrap unit. Because
the runtime bundle covers the guest unit files, the bundle is regenerated to
`4711f8d35b62b530021e995c3542fbafbddd3494155cf0d46b158164d4594484`
(migration `20260828019900` and the generated bundle constant follow), and
the committed guest-package manifest pin under `native-codex/` is refreshed
from the rebuilt package. Rebuilt from that tree with the same retained
inputs as gate 1: guest manifest `878c07de2fa60e0742ce9ae062a4f167281475f4b80604719174ecfbca8fcd5e`,
guest archive `lxd-runner-guest-7c8e69d05.tar.gz`
`0efe52a9f22b2a57b38f57ddadb1b66416806d6861f20928448eca49e0fd9fa9`,
native provider host `883dfa8b…` (it embeds the bundle constant), ephemeral
runner manifest `1530fdd5…`; provider, broker and orchestrator manifests
unchanged. Packager and bundle tests pass. Gate 1 is repeated for this
candidate: node build recipe `build-lxd-runner-image-candidate-7c8e69d05.sh`
installed at the sudoers build path (previous recipe kept as
`.ebbd1e734-recipe-backup.sh`), packet v4 to follow.

## Candidate 2: gate 1 closed again (2026-09-02 03:52–03:58 UTC)

- Build on `company41-node-01` from the pinned recipe: image
  `0fbf44de61e64bf0b722fe035d0f0b8a9b3ff1a9760a03a454174506ee931943`,
  alias `qorpera-runner-4711f8d3-7c8e69d0-candidate-unsigned`, source commit
  and archive/manifest/native-host pins verified by the recipe.
- Clean-boot acceptance: `LXD_RUNNER_IMAGE_CANDIDATE_ACCEPTED_UNSIGNED`
  (UEFI secure boot, no-job boot fails closed). Evidence pin
  `a694611f1236a69c51fb87a798b9001c0bb67d7456920329b3cea772416e7b16`,
  tested at 2026-09-02T03:52:03Z.
- Signed provenance for that exact fingerprint (same off-node key ceremony
  as candidate 1), envelope `2ab6d9b85353cbe4f122464a9ce8dd9a818d73ba2ad0f2311c1f7c9ec64adf96`,
  staged on the node as `lxd-image-provenance-7c8e69d05.*` and verified
  there. **Not activated.** The provider stays disabled.
- Production SQL packet v4: packet `b1a1854f953d184e218662737c76024986ea0c47cf875b14434e0dfe3df26e93`,
  frozen manifest `2b8ab3d97e3d9a2d330d99fda0fcd76a8f8c4fc9183768676e45449787a86903`,
  96/96 tests, offline wrapper rehearsal 41/41 steps (ledger 128, policy
  version 3, concurrency 64). Dispatch disabled; read-only preflight still
  mandatory before any production use. Packet built and frozen with the
  worktree detached at `7c8e69d05` (the builder requires HEAD to equal the
  pinned commit; later commits on the branch are record-only).
- Evidence: `steps02-phase-b-gate1b-20260902.fable/`, seal `SHA256SUMS`
  `47a7c920c713a46e67066c9ae37cccbcacce5cac9d31700cb6de838242108079`.
- Candidate 1 (`ebbd1e734`, image `c1b81ab6…`) is superseded; its image and
  staged envelope stay on the node for the record only.

Status: **proven** for gate 1 of candidate 2. Next: activate bundle
`4711f8d3…` on the branch and repeat the gate-2 job-guest launch.

## Candidate 2: gate 2 rerun preparation (2026-09-02 04:00–04:12 UTC)

- **Branch.** The candidate-1 bundle row (version 2, `25cdf35e…`) is immutable
  by trigger and referenced by the gate-2 run and launch records, so the
  candidate-2 bundle from `20260828019900` was inserted on the preview branch
  as version 3 with the identical manifest and hash and activated exactly as
  19900 does (branch-only numbering; production receives version 2 through
  packet v4). Active bundle on the branch:
  `4711f8d35b62b530021e995c3542fbafbddd3494155cf0d46b158164d4594484`
  (04:01:21Z). Runner code checks only the hash, never the version number.
- **Broker route.** The proof public IP removed at the gate-2 stop was
  re-created (`pip-qorpera-s2-secret-proof`, now `20.240.93.225`) with the same
  single NSG rule from the node's egress to `10.80.1.4:8443`. Because the proof
  CA key had been destroyed after signing and the leaf named only the old
  address, a new proof CA and leaf were issued on the broker VM
  (`reissue-tls.mjs`, same TLS front unit, CA `011e9e19…`, valid 3 days) and
  the new CA replaced the old one in the node proof root, the provider CA
  bundle (`860b2470…`), the gateway guest and the native-host bootstrap.
- **Node proof root** re-pinned in place with backups under
  `backup-candidate1/`: image `0fbf44de…`, guest manifest `878c07de…`,
  provenance envelope `2ab6d9b8…`, transport shim fingerprint, native-host
  recipe (`qorpera-custody-7c8e69d05`, host pin `883dfa8b…`, identity id in
  the provisioning input), provider state reset. Two credential source files
  carried a trailing newline that the guest rejects; stripped.
- **Harness run 4** (`step02-joint-f3933956-r4`, new actors A `a00eaf76…` and
  B `e556cc31…`, same company `391f4bad…`) is up: isolation, fixtures and
  denials passed again, 70 checkpoints, waiting on the control socket.
- Run 3's actor A (`a512a7ac…`) keeps their own identity `3c0a7a8f…`, sponsor
  binding `182add97…` and private session; the new turn is requested as that
  actor outside the harness, after their stale queued job `59854d51…`
  (candidate-1 bundle) is cancelled through the product RPC.

## Candidate 2: job guest launched and run executed (2026-09-02 04:13–04:15 UTC)

- Native host `qorpera-custody-7c8e69d05` provisioned from image `0fbf44de…`
  with actor A's identity `3c0a7a8f…` (`native-host-provisioned-c2.json`:
  signed pins unchanged, key matches the current authority, epoch 0,
  runtime ready). Three provisioning attempts failed first on proof-root
  bookkeeping, not on the runtime: a stale guest-hostname and path pin in the
  guest-side operator, the identity id missing from its input, and a trailing
  newline in a credential source file.
- Run 3's stale job `59854d51…` (candidate-1 bundle) cancelled by its
  requester through `qorpera_cancel_runner_job`; a fresh turn requested as
  actor A in their own session with their own sponsor binding
  (`joint-a-request-result-c2.json`, turn request `30634d55…`, queued).
- Orchestrator started 04:14:15Z: run `30634d55…` materialised under the
  active bundle `4711f8d3…`, runner `884fe5e3…` registered, job guest
  `qorpera-30634d55…` launched from the signed image, **bootstrap unit
  finished (`LXD_RUNNER_BOOTSTRAP_READY`)**, runner activated 04:14:33Z,
  job `7e56b2e5…` leased 04:14:34Z and **completed** 04:14:53Z
  (`qorpera.runner-result/v1`, backend `native-company-runtime`, native
  binary `2f2c26cf…`, execution 17.5 s, provider session present, two
  assistant messages, Company File unchanged). `run-watch-c2.json`,
  `branch-result-c2.raw.txt`, `job-guest-30634d55/`.
- The agent stopped before fixture operations: the 2.7 KB request is admitted
  as a 1 KB excerpt and the model's continuation read was refused as
  `INVALID_ARGUMENTS`. This repeats the 31 August acceptance, where the same
  long case-A prompt failed first and a compact input with explicit paging
  instructions was admitted afterwards; the runtime chain itself is proven.
- Harness run 4 finished cleanly (setup, cleanup and harness passed;
  `harness-r4/`).

Status: **proven** — the candidate-2 image boots, reaches the cloud, activates
and executes a sponsored member turn end to end on the deployed branch. Next:
the compact case-A input for the fixture operations.

## Candidate 2: gate 2 closed (2026-09-02 04:22–04:27 UTC)

- The first finished guest was stopped as idle through the provider's own
  stop action (the orchestrator only stops on delivery failure, so a finished
  acquisition otherwise keeps the identity volume and the next acquisition is
  refused). Then the compact case-A input (the 31 August template with
  explicit `read_context` paging, adapted to run 3's fixtures;
  `joint-a-compact-plan-c2.json`, 2807 bytes) was requested as actor A.
- Run `cdb2be87…`: second job guest launched from image `0fbf44de…`,
  bootstrap READY 04:23:08Z, runner `3ec1a252…` activated, job `044db884…`
  leased 04:23:11Z and completed 04:24:33Z (82 s, backend
  `native-company-runtime`, Company File disposition **published**).
- Effects on the branch (`branch-verify-effect-c2.raw.txt`): revision
  snapshot `50811a6b…` under run `cdb2be87…`, actor A, their sponsor
  binding and bundle `4711f8d3…`, writing
  `step02-joint-f3933956-r3-a-private/output.txt` (68 bytes, file hash
  `4cbf51d4ac9351c90568aedc58e92118c539b07c74673401748cd41bf587c4bc` = the expected effect marker plus newline, receipt
  `62e51368…`); delete of `…-shared/delete-target.txt` recorded as **open
  proposal** `7f5c7faa…` (receipt `b1642872…`), not applied.
- Agent's final message carries `STEP02_JOINT_A_F3933956_OK`: five
  authorized reads succeeded, the expected-denial reads and the denied write
  were reported as unconfirmed rather than claimed, and the canary tool was
  not advertised to A (the managed-secret grant belongs to another member,
  proven earlier tonight). The first (long) input's failure stays preserved.
- Closed: proof NSG rule and public IP removed (`close-c2/`; only the egress
  address remains, broker VM keeps its credentials and deallocates itself at
  23:00 UTC), node transport/provider/orchestrator stopped, both job guests
  and the native host guest stopped, actor A's fixture ban restored.

Status: **proven** — gate 2 (two members, one native agent, every member
device offline, deployed branch runtime) holds for candidate 2. Next gate:
infrastructure-staging approval, then the frozen production package (packet
v4), migration delta and rollback packet, then an approved production
window. **Needs Jonas** for each of those.

Evidence seal for the gate-2 folder after candidate 2: `SHA256SUMS`
`d4c2b146b9d8ffdc5413904c7cf122c26fa86c34e15c7f4645800395baa4c00f` (358 files;
the seal from the first gate-2 stop is kept as `SHA256SUMS.gate2-stop`).

## Production rollout executed (founder approval, 2026-09-02 06:47–07:09 UTC)

Jonas: "I approve everything - go ahead" (infrastructure staging, frozen
production package, migration delta and rollback packet, production window).
Evidence: `production-rollout-packet-v4-activation-20260902/` (HANDOFF.md,
sealed).

- **Read-only preflight (06:47Z):** ledger exactly the 92-version baseline,
  one company, executor `supabase_read_only_user`; work counts all zero except
  96 pending/active August runner registrations (sessions expired 2026-08-28)
  and 14 pending August native login sessions (all expired 2026-08-23/24).
  The packet refuses those rows by design and drains nothing itself.
- **Physical fence:** no runtime process on the node; the idle production
  orchestrator guest `company41-orchestrator-01` and tonight's proof gateway
  stopped; the production registry has been physically detached since
  2026-08-29. **Disabled installation:** signed image `0fbf44de…` and its
  envelope `2ab6d9b8…` staged on the node, verifier tool present, activation
  script not run, provider not running.
- **CLI:** the packet's pinned binary (`42a9fe8b…`) is Supabase CLI 2.116.0;
  the release tarball was re-downloaded, checksum-verified and restored at the
  pinned path. Dollar-quoted blocks pass through it unchanged (probed).
- **Administrative drain (07:01:56Z, `drain/drain.sql` `f377ac00…`):** one
  serializable transaction under the packet's executor, ledger and zero-work
  guards; 96 runners set to `revoked` with the owner (who registered every one
  of them and approved the drain) as revoker, 96 `runner_revoked` audit rows
  whose payload names the deployment-administrator execution; 14 expired
  pending logins set to `expired`. Two earlier attempts were refused before
  commit (server syntax rejection of a malformed file; the runner check
  constraint requiring a revoker) and left production unchanged (readbacks
  kept). After the drain all eight work counts read zero.
- **Activation successor:** packet copied to a stable root, README counts
  corrected (36 files, 41 steps, 128 ledger), `contract.mjs` root re-pinned,
  four release receipts written and their hashes bound, execution window
  07:03:18–08:53:18Z, `check` passed (execution enabled, gate bindings issued),
  96/96 packet and transport tests at the pinned commit.
- **Execution (07:03:21–07:08:58Z), one explicit call per step, one CLI
  invocation each, every step a durable PASS:** preflight (policy enabled v1,
  legacy active) → pause (policy disabled v2, pause reason matched) → retire
  (legacy retired) → stage A 11 files (ledger 103) → attest (server authority
  digest and teardown matched) → stage B 25 files (ledger 128; `19900`
  activated bundle `4711f8d3…`; `19990` concurrency 64; `19995` policy
  version 3) → final readback (interfaces matched, admission still disabled,
  all work counts zero, all 92 historical versions retained including the 18
  production-only ones). No reconciliation was needed; no failure artifact
  exists.
- Independent read-only confirmation afterwards: ledger 128, bundles v1
  `184eac72…` and v2 `4711f8d3…`, active `4711f8d3…`, runners all `revoked`.

Status: **proven** — production SQL deployment for candidate 2 complete.
Admission stays paused (policy disabled). Not done and not claimed: node
image activation for production, normal v3 bootstrap, identity/key-backup
recovery agreement, governed registration, the two-member offline production
acceptance, and the controlled policy reopening. Each is a subsequent gate.

Activation evidence seal: `production-rollout-packet-v4-activation-20260902/SHA256SUMS`
`db33c677aad319bda45fc25cd5a0d97e0eeeecbb46eed9403f75a4c9c3663cdb` (198 files:
packet, release receipts, 82 step artifacts, drain, handoff).

## Node activation of the signed candidate-2 image (founder instruction, 2026-09-02 07:12–07:21 UTC)

Jonas: "go ahead with the node activation". Evidence:
`node-activation-7c8e69d05-20260902/` (ACTIVATION.md, scripts, seal
`806b75f56d3958bc5e4128e8f422ea1d85a99588f8cd9533423021a3070667e1`).

- The 27 August production provider on `company41-node-01` was the legacy
  `lxd-company-computer` backend with a retired NAS precondition, disabled and
  inactive. Its package, envelope and configuration are backed up in place.
- Production guest profiles `qorpera-job-v2` and `qorpera-login-v2` were
  created in project `qorpera-runners` from the signed-acceptance profiles
  (no host filesystem mounts, NIC filtering and port isolation).
- Through the sudoers activation path: the signed envelope `2ab6d9b8…`
  verified for image `0fbf44de…` and guest manifest `878c07de…`
  (`LXD_IMAGE_PROVENANCE_VERIFIED`); the candidate provider package
  `767e5d2b…` and verifier tool installed under `/opt/qorpera/company-provider`;
  the envelope installed as the company provider's provenance; a root-only
  62-key configuration written (backend `lxd`, adapter
  `lxd-company41-node-01`, API on `10.41.0.1:8081` trusting only the
  orchestrator address, production Supabase project, image and manifest pins,
  the new profiles, node-generated guest tokens, broker CA bundle); a unit
  drop-in removed the retired NAS mountpoint precondition; unit enabled.
- Two startup refusals fixed in place: token files must be owned by the
  service user (0600), and the native login gateway must bind to loopback.
- Result: `qorpera-lxd-company-provider.service` enabled/active, zero
  restarts since 07:19:31Z, listeners `10.41.0.1:8081` and `127.0.0.1:8085`
  only; the host's own probe is refused (403) by the trusted-source fence.
  Legacy provider unit still disabled; orchestrator guest still stopped; NAS
  not mounted; cloud policy still disabled, so no admission is possible.
- Deliberately pending in the configuration: broker origin
  `https://10.80.1.4:8443` (private address, current proof CA) until the
  recovery-agreement gate re-points and re-issues the production broker; object
  gateway `https://gateway.pending.invalid:9444` until the production gateway
  guest exists (governed-registration gate). Node id
  `24f2a7c5-cdc1-4c23-8e99-e445623eacb2`.

Status: **proven** — signed image activated on the node, provider up and
fenced. Next gates: production broker route and TLS (recovery agreement),
production object gateway guest and orchestrator configuration (governed
registration), then the offline two-member production acceptance and the
controlled policy reopening.
