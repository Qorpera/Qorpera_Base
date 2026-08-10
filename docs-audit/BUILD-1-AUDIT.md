# Build 1 Audit — Company Environment, Trail, Portability

**Status:** Complete — findings recorded, round-trip implemented and tested (`company export` / `company import`, company.test.ts "environment export and import")
**Date:** 2026-08-10
**Base:** `claude/base-minimum` @ origin/master (1bb406d3d, post-PR #3)
**Plan reference:** `QORPERA-BASE-BUILD-PLAN.md` §3

## 1. Company-folder spine classification

Scaffold: `scaffoldCompany` (packages/coding-agent/src/core/company.ts:1843-1885). Required paths enumerated in `validateCompanyKernelStorage` (company.ts:272-298); `trail/` and `inbox/` must be physical trees (no symlink/junction, company.ts:248-270).

| Path | Class | Written by | Notes |
|---|---|---|---|
| `company.md` | required, agent-editable | scaffold once, never overwritten | founder intent |
| `authority.toml` | required, **protected** | scaffold; founder via token-gated `/api/authority*` with native modal review; agent writes gated (class `authority`) AND sandbox read-only | mode force-set to `gate` on read and write |
| `AGENTS.md` / `CLAUDE.md` | required, **kernel-owned** | overwritten on every scaffold ("kernel refreshed") | protected path class `authority` |
| `trail/` | required, **kernel-append-only** | kernel only (child emits `qorpera_trail_append`, kernel validates + appends) | see §2 |
| `inbox/` | required, protected except `inbox/messages/msg-*.md` | kernel + gated agent writes | founder-decision channel |
| `app/` (`projection.json`, surfaces, substrates, routines, tools) | required, agent-owned | agent | `routines/` and `tools/` currently have **no runner/executor** |
| `departments/` | required, agent-owned | agent | |
| `userland/` | kernel-managed fork of shell chrome | userland-manager only (userland-manager.ts:22-27) | `.base/`, `.update/`, `.versions/` |
| `.qorpera/` | required, protected | kernel (`settings.json` forced: `sessionDir:"./trail"`, compaction off; `products.json`; `w/*.bundle` recovery bundles; `product-worktrees/*.json`) | inventory now explicit — see §1.1 |
| anything else | fully agent-owned | agent | no registration required — confirmed |

### 1.1 `.qorpera/` inventory (manifesto §3.3 obligation)

In-folder (exports, forks): `settings.json` (re-forced on open anyway), `products.json`, `w/*.bundle` product recovery bundles, `product-worktrees/`. **Outside the folder (never exports — this is what makes fork-severs-authority work today):** real credentials `~/.qorpera/agent/auth.json` (plaintext, mode 0600 — no keychain, contradicting docs/company.md:194-196); machine-local kernel state incl. durable gate trust at `<userData>/company-kernel-state/<sha256(root)>/state.json`; pending checkpoints at `<userData>/agent-sandbox/<rootId>/checkpoints/`; company registry `~/.qorpera/agent/companies.json`.

### 1.2 Demonstrated gap: inconsistent company anchor

Three call sites disagree on what makes a directory a company: `isCompanyRoot()` checks `company.md` (shell/src/main.ts:306-311), `listCompanies()` filters on `authority.toml` (company.ts:2468), `company product add` checks `company.md` (company.ts:2396). Not closed in this build (behavioral churn beyond recording); flagged for unification on the `validateCompanyKernelStorage` predicate.

## 2. Trail completeness

Location: `<company>/trail/<ISO>_<uuid>.jsonl`, one file per session; stock session format bound to the company (`sessionDir:"./trail"` — "sessions ARE the trail", SEAMS.md d). Header `{type:"session", version:5, …, qorpera:{actor, attended, autonomous, label, department, worktree}}` written at bind (agent-runtime.ts:296-333).

| Record | Preserved? | Where |
|---|---|---|
| Inputs and outputs | ✅ | full `AgentMessage` entries, whitelist agent-runtime.ts:159-168 |
| Provider thinking blocks / reasoning summaries | ✅ structurally | `ThinkingContent` incl. signature + redacted flag (ai/types.ts:359-367); broker forwards all stream events verbatim; nothing strips |
| Tool calls and results | ✅ | message entries + `qorpera_effect` custom entries (tool, effect class, decision, gateId, behavior hash + signature status) agent-session.ts:526-543 |
| Model and provider identity | ✅ | message attribution + kernel-observed `qorpera_kernel_model_request` (provider, model, request sha256, status, budget reservation, usage) |
| Errors, interruptions, retries | ✅ | session entries + crash-safe pending-checkpoint reconciliation |
| Kernel-observed effects | ✅ | `qorpera_kernel_*` entries: input, model_request, founder_mutation, product_storage, gate_transition, inbox_message |
| Authority decisions | ✅ | `qorpera_effect` + gate transitions + founder mutation journal |

**Append-only: verified, four independent layers.** (1) `SessionManager._rewriteFile` throws when kernel-bound (session-manager.ts:990-994); (2) only the kernel writes the file — child appends go through a validated stdout frame; (3) per-entry hash chain (`kernel:{sequence, previousHash, hash}`), re-verified on resume, throws on break (agent-runtime.ts:257-294); (4) OS sandbox marks `trail/` read-only for the child (agent-runtime.ts:1174-1188).

**Provenance honesty (carried forward, not a Build 1 fix):** trail message *content* is a child assertion (`{source:"child", trust:"assertion"}`); the kernel observes request hash/usage but never response bytes, so "thinking blocks preserved" is attributable, not kernel-verified. docs/authority.md:203-206 states this. Consistent with EVOLUTION §8.5 "attributable, never reproducible". No change required by the plan; recorded so nobody later claims more than this.

**Format documented/versioned/self-describing:** versioned (v5 header), self-describing JSONL — but the entry taxonomy (esp. `qorpera_kernel_*` and `qorpera_effect`) was documented only in code. **Gap (recording-adjacent, in scope): a trail-format reference doc.** → closed by `packages/coding-agent/docs/trail.md`, derived from the validators.

## 3. Git + non-Git storage coexistence

- Turn checkpointing commits only paths dirtied this turn, with the trail session file force-included and stamped as commit provenance (`Qorpera-Trigger: trail/<session>.jsonl`) — company-checkpoint.ts:234-290.
- Founder state is snapshotted (index and working tree separately) before any agent write — :148-173.
- Product worktree binary state → verified incremental git bundles under `.qorpera/w/`, chained and byte-exactness-checked — :375-489.
- **No SQLite is used by companies today** (the sqlite session backend exists but is not company-bound). Arbitrary agent-created databases would be committed as binary blobs by turn checkpointing.
- **Quiesce point exists:** checkpoints fire on `agent_settled` and child close (main.ts:737-798), so a copy taken between turns is consistent. Export therefore requires the controller stopped or settled — this is the snapshot-consistency design: **export/snapshot are defined only at checkpoint boundaries**, enforced by refusing export while a child is running (kernel-side) or by documenting the CLI as offline-only (CLI-side, this build).

## 4. Environment identity and contract version

- **Environment identity:** already machine-local by construction — kernel state is keyed by `sha256(canonical root path)`, so an imported/cloned/moved company gets fresh kernel state (fresh durable trust, no standing gate capabilities). This satisfies "a fork receives a fresh environment identity" without a new mechanism; recorded as the designed behavior rather than an accident.
- **Contract version: did not exist.** → closed: `ENVIRONMENT_CONTRACT_VERSION` stamped into the export manifest (`qorpera.export/v1`), checked on import.

## 5. Export → inspect → import round-trip

**Did not exist** (the only prior art is `qorpera fork <repo>` = `git clone --no-hardlinks`, company.ts:2357-2381). Closed in this build:

- `qorpera company export <companyDir> <targetDir>` — full copy of the company folder (including `.git` and `trail/`) plus `export-manifest.json` (schema `qorpera.export/v1`, contract version, source HEAD, exported-at). Secrets and standing authority never leave the machine because they were never in the folder (§1.1).
- Inspectable independently: the export is plain files — Git history, JSONL trail, markdown — readable with no Qorpera installation.
- `qorpera company import <exportDir> <targetDir>` — manifest + contract-version check, copy, `validateCompanyKernelStorage`, Git HEAD verification. Fresh environment identity and zero inherited trust follow from §4.
- Round-trip proven by test: scaffold → export → independent inspection assertions → import → spine + HEAD equality → no kernel state carried.

## 6. Other demonstrated gaps recorded for their proper builds (not Build 1)

- **EVOLUTION §3 signature rule currently has no live trigger path**: in-process extensions are hard-disabled under the kernel (`agent-session-services.ts:148-172`), so `behaviorPath` never resolves to in-company code and unattended-outward signing never fires. `app/tools/` and `app/routines/` are scaffolded but have no executor. This is precisely Build 2's job (sandboxed company-authored capabilities) — the signature rule becomes real when the first out-of-process tool path lands.
- **Gate/sandbox disagreement:** a founder-approved `[authority]` gate to write `authority.toml` still cannot execute because the sandbox marks the file read-only. Resolve in Build 2 when the sandbox profile is revisited (founder-authenticated policy mutation via the endpoint is the supported path; the gate class should say so instead of implying agent-side writes can proceed).
- **Non-Windows sandbox verification is absent** (`provisionWindowsSandbox` returns immediately off-Windows) — Build 2 isolation-honesty obligation.
- **No keychain** for `~/.qorpera/agent/auth.json` — Build 3 (secret store hardening); docs/company.md:194-196 currently overclaims.
- **No scheduler/wake/event mechanism, no headless mode** (companies run only under the Electron kernel) — Build 4 territory; kernel prompt language about routines/wakes overclaims today.
- **No MCP client or server** — Build 3 / optional module respectively.
