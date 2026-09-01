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
