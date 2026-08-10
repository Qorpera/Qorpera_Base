# Build 1 Audit — Company Environment, Trail, Portability

**Status:** In progress
**Date:** 2026-08-10
**Base:** `claude/base-minimum` @ origin/master (1bb406d3d, post-PR #3)
**Plan reference:** `QORPERA-BASE-BUILD-PLAN.md` §3

## 1. Company-folder spine classification

For each spine path: platform-required / optional / protected / fully agent-owned, with the code that reads or writes it.

| Path | Class | Read by | Written by | Notes |
|---|---|---|---|---|
| `company.md` | TBD | | | |
| `authority.toml` | TBD | | | provenance status: TBD |
| `trail/` | TBD | | | append-only status: TBD |
| `inbox/` | TBD | | | trusted-channel split: TBD |
| `app/` | TBD | | | projection contract: TBD |
| `.qorpera/` | TBD | | | inventory: TBD |

## 2. Trail completeness

| Record | Preserved? | Where | Gap |
|---|---|---|---|
| Inputs and outputs | TBD | | |
| Provider thinking blocks / reasoning summaries | TBD | | |
| Tool calls and results | TBD | | |
| Model and provider identity | TBD | | |
| Errors, interruptions, retries | TBD | | |
| Kernel-observed effects | TBD | | |
| Authority decisions | TBD | | |

Trail format documented/versioned/self-describing: TBD
Kernel-append-only from the controller's perspective: TBD

## 3. Git + non-Git storage coexistence

Current handling of SQLite/other live databases vs Git history: TBD
Snapshot-consistency design (quiesce point): TBD

## 4. Environment identity and contract version

Current environment identity, if any: TBD
Where the contract version will be stamped: TBD

## 5. Export → inspect → import round-trip

Existing checkpoint/export machinery: TBD
Round-trip demonstration: TBD

## 6. Demonstrated gaps to close (and nothing else)

- TBD
