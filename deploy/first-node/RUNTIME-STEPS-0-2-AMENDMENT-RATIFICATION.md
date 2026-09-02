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
