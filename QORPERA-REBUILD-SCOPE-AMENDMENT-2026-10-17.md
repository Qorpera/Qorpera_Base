# Qorpera rebuild scope amendment — 17 October 2026

Status: founder scope correction, recorded for integration into the runtime contract and active execution plan. This document changes requirements; it does not claim that implementation, deployment or acceptance is complete.

## Authority and precedence

Jonas clarified the intended scope in the Codex rebuild audit on 17 October:

> with regards to the memory rebuilt, that should have been an added test/beta feature you could toggle in settings between that and the legacy per-agent memory that grok bot uses too. the interfaces at first werent meant to be costum interfaces, but specially designed interfaces we would let you turn on and use, that connected to your data. we would only focus on the mail-box and member-to-agent-ownership split page

This correction supersedes conflicting requirements and completion criteria in `QORPERA-RUNTIME-CONTRACT.md`, its 2 October Interfaces amendment, its 6 October summary-tree amendment, affected coding extras in its 14 October amendment, and their implementation plans. Earlier approvals remain historical records; they are not authority to continue the broader scope against this correction.

The goal is to complete the company-folder rebuild and the retained behavior below. An approved future feature, a merged component, or a reference to another product does not automatically make that feature a prerequisite for rebuild completion.

## 1. Memory: supported notebooks and an optional beta

### Product requirement

- **Agent notebooks remain supported and are the default.** Each agent retains its company-owned profile, log and note memory, with the existing write, forget and recall behavior. Ordinary conversation context remains supported with the beta off.
- **Shared summary-tree context is an optional test/beta mode.** An authorized member selects it in Settings and can return to notebooks. It is not a mandatory successor to notebooks.
- The smallest implementation uses a **company-level Settings choice**, matching the existing company-level tree gate and shared-context design. “Per-agent memory” describes ownership of the legacy notebooks. A new per-agent selector or mixed-mode sharing model is not part of this amendment.
- Suggested labels are **Agent notebooks** and **Shared context — Beta**. The latter may be unavailable until its enablement checks pass. Core completion must not wait for the full beta to become available.
- No founding flow, deployment, background job, or completion of a memory implementation step may silently enable the beta. Operator test allowlisting does not substitute for the requested member-facing choice.

### Containment and switching

- Preserve the mode gate. Cancel the planned automatic all-company rollout and notebook retirement. Completing W1d must not remove the gate merely because erasure work is complete; M5 must not trim notebook tiers/tools. Replacing profiles with pins is separate future work.
- Apply the selected mode consistently to conversation views, new run logs, context folding/composition, and tree-specific background processing. A checkbox that changes only the primary conversation view is insufficient.
- Record a coherent mode for each run. A mode change applies to new runs at a defined boundary; an active or resumed run keeps its recorded mode until it finishes or is explicitly stopped. Settings must explain any pending transition. Do not silently switch composition halfway through a run.
- A mode switch does not delete or rewrite notebooks, transcripts, tree files or run logs. Preserve existing permission, erasure and retention obligations, including while the beta is off. Re-enabling the beta must not resurrect erased content.
- Keep existing notebook tools available in the beta where already implemented. Do not add automatic bidirectional conversion, dual-writing or a history migration to this scope. Preservation does not promise identical recall between two different memory modes.
- Beta-specific quality, performance, compaction, run-resume and rollout work belongs to beta enablement. It is not a blocker for proving notebook-mode core behavior. Shared fixes needed for ordinary runs remain core work.

### Evidence and required work

As inspected on 17 October, the legacy notebook implementation remains in the runtime. Tree use is gated by `qorpera_memory_tree_companies`, but no member-facing mode setting was found. PR #1046 adds a gate for new run logs; its migration comments plan to remove that gate after W1d, and existing logs may continue after allowlist removal. Therefore changing the allowlist alone is not proof of a reversible Settings choice.

Do not edit an already applied migration to implement the correction. Use the smallest forward change that preserves a durable effective-mode check and existing data.

## 2. Interfaces: two purpose-built, user-enabled pages

### Product requirement

Interfaces are pages supplied and designed by Qorpera. A member enables one and connects it to existing authorized data. The initial scope is exactly:

1. **Mailbox:** the company's selected authorized mail source, message/thread reading, and existing required mail actions and protections.
2. **Member-to-agent ownership:** show and manage which members own or supervise which agents, with the consent, transfer and departure handling needed to keep that mapping correct.

The member selects supported connections/accounts or other necessary source settings. This is configuration of two product pages, not a generic data-binding editor.

Company Pulse, generic work-card boards, custom interfaces, agent-designed pages, a visual page builder, additional interface types, a marketplace, template updates and a larger generic table store are outside this rebuild. Arrival animation is not a completion requirement. Existing payment constraints and supervision rules remain applicable; the ownership page does not authorize new autonomous-work or payment semantics. Unfinished autonomous-work payer changes are not a prerequisite for this page unless explicitly retained in the core work list.

### Containment

- Reuse existing trusted renderer, parser and table/data components internally where that is the smallest path. There is no requirement to delete or replace them.
- The two pages start disabled until an authorized member enables them. Enabling/disabling a page controls its presentation; it does not itself change ownership, payment, consent or underlying data.
- Only the two supported page types may become active. Normal navigation, direct routes and fallback paths must enforce the same boundary. Existing Pulse/custom definitions may remain stored but are not exposed as supported active pages.
- Layouts and available actions are platform-owned. Members configure the allowed activation and source fields; agents do not create or redesign interfaces. Fixed page names alone are insufficient: a custom definition cannot replace the supported Mailbox or ownership page under the same name.
- Remove custom-page authoring from the agent tool catalog and enforce the boundary for older/replayed tool calls, ordinary file writes and mounted-folder writes. Disabling `save_interface` alone is insufficient if another write path can still activate an arbitrary definition.
- Preserve authorized access to underlying business data. Do not disable all table reads/writes indiscriminately: keep operations needed by the two pages and existing retained behavior. Generic schema/layout authoring is not an exposed product requirement.
- Keep mail provenance/quoting, account-mail restrictions, viewer authority and safe action execution. Scope reduction does not weaken those protections.
- Preserve stored files, rows, offers and consent records. Do not create a mass-deletion, storage-migration or framework-removal project to implement this correction.

### Work to stop or narrow

- Stop Pulse and its additional numbers/activity/calendar work, custom-page creation/editing, and further interface-authoring preview/Undo work.
- Stop generic block completion that neither of the two pages requires.
- Restrict Members work to the requested ownership/supervision split. Generic work assignment boards and richer workflows are separate enhancements.
- Finish Mailbox data wiring and actions needed for a usable page. Additional browser polish is not automatically a core blocker.
- Existing completed components remain an inventory, not permission to expose or finish their broader feature set.

## 3. Coding extras and retained execution work

The following are deferred product enhancements, outside core rebuild acceptance:

- Remaining setup-file automation and reusable setup snapshot builders/integration (remaining step 5h).
- Coding development-server previews, their authenticated proxy and agent browser integration (5i).
- Compatibility expansion for external repository-configuration ecosystems beyond what retained core execution actually requires.

This is a phase boundary, not a rollback. Keep the already merged setup parser and snapshot records (#1100 and #1131) dormant. Do not remove their tables, undo migrations or create cleanup work just to mark the feature deferred. Empty-setup coding machines are an accepted core baseline. Ordinary package installation and supported core execution remain available.

Retain machine/coding execution, company-folder access, root/Docker, code custody, secrets/password vaults, necessary MCP/credential handling, existing connector behavior, persistence, recovery and access controls. Classify additional capacity or infrastructure expansion against those retained requirements before starting it; another product's capability list is not an open-ended mandate.

Do not accidentally defer the CPU/byte measurements needed for correct idle sleep and quiet-day archival when evaluating broader capacity work.

## 4. Completion and acceptance

Maintain three separate tracks. A failed safety or correctness check for an enabled core capability stays a core blocker. A deferred capability's absent implementation is not a failed core acceptance test.

| Track | Completion boundary |
| --- | --- |
| **Core rebuild** | Company-folder operation and retained machine/coding/credential behavior; notebook memory with beta off, plus the smallest company Settings choice (default **Agent notebooks**; **Shared context — Beta** may show as unavailable), a mode recorded per run (turning the beta off applies at the next run boundary) and the mode gate made permanent by a forward change; the two bounded Interfaces; compatible signed deployment and live acceptance. |
| **Memory beta enablement** | Making the beta option selectable: consistent mode enforcement, data preservation, trust/privacy/erasure and operational checks before beta is offered. Unfinished beta is clearly unavailable and does not hold core completion. |
| **Deferred enhancements** | Custom interfaces, Pulse, snapshots, coding previews/browser and other explicitly parked additions. No automatic resumption after a deadline or because an agent becomes idle. |

### Minimum proof of the corrected scope

**Core memory**

- With beta off, each agent can write, forget, recall and compose its own notebook; ordinary history and machine workflows still work.
- New notebook-mode runs do not silently create tree-based work logs or use beta context composition/compaction. Existing beta-run transitions and required data maintenance follow the recorded-mode rule.
- The company Settings choice exists with **Agent notebooks** as the default (the beta option may show as unavailable); each run records its mode, turning the beta off applies at the next run boundary, and the mode gate is permanent through a forward change.

**Before beta activation is offered**

- Defaults, authorization and durable mode selection are correct; deployment and founding do not silently opt in.
- The selection controls both conversation and work-log/composition paths.
- On → run → off → run → on preserves source data and does not duplicate effects; active/resumed runs remain coherent.
- Erasure continues with beta off, and re-enablement cannot restore erased information. Beta failures cannot change notebook companies' mode or data.

**Interfaces**

- Only Mailbox and member-to-agent ownership can be enabled, by an authorized member, using allowed data sources.
- Mailbox reads the selected source with existing access and quote protections.
- Ownership changes, required consent and departure handling persist and are reflected by the existing runtime rules.
- Pulse/custom pages remain unavailable through normal, direct-link and fallback routes. Agents cannot create or redesign pages through any applicable write path.
- Disabling a page preserves business data and does not silently change supervision, payment or ownership.

**Execution and deployment**

- Keep core persistence, concurrency, authority, credential custody, coding commit/push/PR, interruption/recovery, idle/sleep/archive and deployed behavior checks.
- Remove only cases that specifically require now-deferred capabilities. Preserve evidence for unchanged behavior; rerun checks affected by new fixes or newly found failures.
- Distinguish component tests, test-machine proof and deployed acceptance. Do not claim the whole rebuild complete from a passing component suite.

### Current known correction to the status report

The coordinator's 17 October 16:12 UTC entry withdrew the full P3 phase-B claim. Exact-head run 11 failed idle-sleep detachment: a live but idle command kept refreshing `busy_at`, so earlier passes depended on timing. Sleep and quiet-day archival need a deterministic fix and a fresh proof. Other successful coding steps remain useful evidence, but do not erase this failure.

Other currently recorded core work includes folder-service restart/unproven-read recovery, remaining required machine wiring, signing-key availability, coordinated rollout and deployed acceptance. This is a starting list, not a claim that every remaining defect has been enumerated.

## 5. Execution reset and document reconciliation

The coordinator owns one finite remaining-work list. Each core item names its retained user-visible behavior, owner, dependencies, next acceptance check and current evidence. Split mixed tasks into core and optional portions; do not multiply the tasks merely to report progress. Record uncertainty rather than promising an ungrounded completion date.

Before starting or continuing an enhancement, identify the retained requirement it satisfies. If it does not satisfy one, park it. Ordinary implementation decisions needed for retained behavior remain delegated; a new product capability or completion prerequisite requires an explicit scope decision with its effort and dependency implications.

The 17 October assignment of 5i after 5k is superseded by this amendment. Preserve useful unmerged work without merging/exposing it merely to clear the queue. Stop or reassign conflicting work and report the change to the coordinator's core list.

Reconcile the following documents and active briefs. Historical build records should be preserved and clearly marked where superseded:

| Document | Required reconciliation |
| --- | --- |
| `QORPERA-RUNTIME-CONTRACT.md` | Apply this amendment's precedence; qualify tree requirements by selected mode wherever an "Amended 2026-10-06" note sits: §§5.3, 5.4, 5.6, 6.1, 9.1–9.3, 13, 14.1, 14.2, 15.1, 17 and 19, and §21 items 8 and 9 (checking item 15 against notebook mode); override custom Interface/three-page requirements; separate optional coding extras from core acceptance. |
| `deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md` | Replace universal replacement/rollout in §§11, 13, 14 and 16 with optional beta; redefine M5 as reversible Settings selection; cancel automatic notebook retirement and gate removal. |
| `deploy/first-node/RUNTIME-STEP-6-MEMORY.md` | Record notebooks as supported/default; preserve their per-agent behavior. |
| `deploy/first-node/RUNTIME-INTERFACES.md` | Correct opening scope and §§1–2, 7–10; bound I1 (rail tab listing and routes `#/c/{id}/i/{interface}`) to the two pages; stop I4/custom I8/I10; bound I2/I3/I6/I7/I9 and necessary I5/I11 to the two pages. |
| `deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md` | Remove mandatory Pulse/numbers/cards seeding from new-company requirements; retain necessary data and platform-owned page configuration. |
| `supabase/CLIENT-CONTRACT.md` | Document supported page listing, fixed layouts, activation/configuration, direct routes and fallback restrictions. |
| `deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md` | Mark remaining 5h/5i deferred and split 5m core proofs from future-feature proofs. |
| Coordinator registry, release list, feature briefs and launch checklist | Record this scope reset, stop conflicting dispatches, retain real core blockers, and separate optional enablement and deferred work. |

The implementation handoff must call out the future removal instruction in `20260930352000_memory_run_log_gate.sql`; preserve an effective mode gate through a forward change rather than editing a merged migration.

This amendment authorizes scope correction and implementation planning. It does not itself authorize a new production deployment, destructive data migration, or deletion of user records. Completion reporting must distinguish **scope recorded**, **work reassigned**, **behavior implemented**, and **behavior verified**.
