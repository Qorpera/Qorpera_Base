# Qorpera Base Minimum Build Plan

**Status:** Ratification draft (review edits applied)
**Date:** 2026-08-10
**Implementation base:** A fresh worktree from the latest `master` (`claude/base-minimum`); not the detached pre-PR #2 checkout in which the first draft was prepared.

## 1. Objective

Build the minimally viable environment around a self-evolving company-file.

The plan deliberately excludes provider-specific bridges, universal company schemas, and a connector platform. It builds only the capabilities an agentic controller cannot safely or reliably construct from inside its own company folder.

The sequence is:

```text
Ratify the minimum
-> verify the company folder and trail, and prove export/import
-> run company-authored capabilities safely
-> provide generic connectivity
-> provide durable autonomy with integrity
-> complete environment operations
-> add refinements only when real company experience demands them
```

Environment operations are designed from the first build and **proven** from the first build: Build 1 ends with a demonstrated export→inspect→import round-trip, because portability is the thesis's most falsifiable claim and the cheapest to prove, and proving it first constrains every later storage choice. No storage or authority choice may make snapshot, restore, export, playback, or fork impossible.

## 2. Build 0 - Ratify the minimum

### Purpose

Prevent the implementation from drifting back into an ontology, connector platform, or speculative cloud backend.

### Deliverables

- Shared architecture issue.
- `QORPERA-BASE-ARCHITECTURE-MANIFESTO.md`.
- This minimum build plan.
- A short decision record (`QORPERA-BASE-DECISION-RECORD.md`) defining:
  - Company folder.
  - Company environment.
  - Durable trail.
  - Agentic controller.
  - Trusted kernel.
  - Capability.
  - Optional kernel module.
  - Environment operation.
- Explicitly deferred features.

### Completion condition

A founder can explain what Base does without understanding provider-specific synchronization, storage-engine internals, or cloud implementation details.

## 3. Build 1 - Verify the company environment, durable trail, and portability

### Purpose

Confirm that the current company folder is a sufficient free-form substrate, that the available controller process is preserved without inventing a second universal data layer, and that the environment provably round-trips out of and back into Base.

### Work

- Audit the current company-folder spine after the latest `master` changes.
- Confirm which paths are platform-required, optional, protected, or fully agent-owned; publish the `.qorpera/` runtime-metadata inventory (what exports, what survives restore, what a fork receives).
- Confirm that trail records preserve:
  - Inputs and outputs.
  - Provider-exposed thinking blocks and reasoning summaries.
  - Tool calls and results.
  - Model and provider identity.
  - Errors, interruptions, and retries.
  - Kernel-observed effects and authority decisions.
- Confirm the trail format is documented, versioned, self-describing plain files inside the exportable environment.
- Confirm (or establish) that the trail is kernel-append-only from the controller's perspective.
- Close only demonstrated recording gaps.
- Design snapshot-consistent storage for Git + non-Git files (SQLite and other live databases): snapshot and export quiesce the controller first. This is a design obligation, not a documentation task.
- Define the minimum environment identity needed for snapshot, restore, and fork without imposing company ontology, including the environment contract version stamped into every export and snapshot.
- Implement and demonstrate export→inspect→import: export a company environment, inspect it independently of the running installation, import it, and verify the result is the same environment.

### Explicit exclusions

- Universal artifact store.
- Universal observation schema.
- Connector database.
- Provider-specific synchronization.
- New UI ontology.

### Acceptance criteria

- A complete available model/tool journey can be reconstructed from the trail.
- Nothing stored is automatically injected into future model context.
- The controller can create arbitrary files and databases without platform registration.
- Existing projection and Usage features remain projections over company state.
- A demonstrated export→inspect→import round-trip reproduces the environment, with the environment contract version recorded.
- The trail format is readable without the running installation.

## 4. Build 2 - Sandboxed company-authored capabilities

### Purpose

Let the controller build arbitrary backend tools without loading them into the trusted kernel or granting them ambient host authority.

### Work

- Provide a sandboxed subprocess path for company-authored code, with the enforcement mechanism named per supported platform. Where OS-level filesystem/network confinement is not yet implemented, say so explicitly and scope the isolation claim to what is enforced (credential denial and clean environment are real from day one; confinement claims wait for their mechanism).
- Preserve the existing freedom to choose language, file layout, dependencies, and internal schema.
- Start processes with a clean environment.
- Limit filesystem access to the assigned company or product scope, by the named mechanism.
- Remove ambient model, cloud, Git, connector, and desktop credentials.
- Record invocation, output, failure, interruption, and acting code identity in the trail.
- Reuse the current content-hash signature rule for unattended outward behavior where possible.

### Explicit exclusions

- Bridge marketplace.
- Mandatory bridge manifest.
- Qorpera-specific provider SDK.
- Provider-specific tools.
- In-process company extensions.

### Acceptance criteria

- The controller can create and execute a useful local backend program.
- The program cannot access files outside its capability, or the residual gap is explicitly documented and gated by authority policy.
- The program cannot obtain kernel credentials or unrestricted network access.
- Raw secret values never enter the sandbox (references only; see Build 3).
- Changing signed outward behavior changes the identity covered by the signature.
- All available execution output remains attributable in the trail.

## 5. Build 3 - Generic connectivity

### Purpose

Allow the company controller to adopt existing tools or build missing connections without Qorpera becoming the connector author.

### Work

- Add an MCP client for external MCP servers, consuming the same secret-reference mechanism as all other outbound contact.
- Provide protected secret references suitable for company-authored tools. The mechanism is kernel-side dereferencing: controller context and sandboxed code carry opaque references; the kernel injects raw values into outbound requests at the trusted boundary. This — not diligence — is how credentials stay out of company-authored code, prompts, ordinary trails, and gate files.
- Provide kernel-mediated credential lifecycle: rotation and OAuth refresh write new values into the protected store through the kernel, never through sandbox write access to the vault.
- Provide narrow network capabilities by destination and acting behavior.
- Record the destination, behavior identity, request identity, result, and authority outcome without requiring provider ontology.
- Support attended use first.
- Support signed, scoped unattended use through the existing authority model.

### Explicit exclusions

- MCP server surface (moved to optional kernel modules; see §8).
- Google Drive connector.
- Nordea connector.
- GitHub connector implementation.
- Universal cursor or checkpoint schema for company data. (Kernel-internal checkpoints of the kernel's own interrupted operations are a Build 4 concern and are not this.)
- Universal connector effect taxonomy.
- Provider data normalization.

### Acceptance criteria

- The controller can use an external MCP tool.
- The controller can author a local tool for a service with no MCP server.
- The local tool can use a scoped secret reference or network capability without receiving ambient kernel authority or raw secret values.
- A secret that requires refresh is refreshed through the kernel and keeps working without the sandbox touching the vault.
- The company decides how provider data and incremental state are stored.

Multi-provider capability sharing (an OpenAI controller and an Anthropic controller reaching the same capability through the Qorpera runtime rather than owning separate credentials) is a controller-runtime property; it is verified in the controller runtime's own tests, not gated here.

## 6. Build 4 - Durable autonomy with integrity

### Purpose

Let a company continue operating when no interactive chat is open — without the autonomy machinery becoming the thing that corrupts or bankrupts the company.

### Work

- Add a minimal durable wake mechanism.
- Support schedule, founder response, and operation-completion causes. (Inbound external events require an inbound listening capability — an optional kernel module, out of the minimum.)
- Record a kernel-issued causal identity for each wake.
- Serialize environment access: a wake that fires while another controller session is active queues or coalesces per kernel policy; two controller instances never mutate the same environment concurrently. Policy decisions are trail-recorded.
- Define missed-wake policy (host asleep, environment paused): coalesce, fire, or drop is a kernel decision, recorded.
- Enforce kernel-owned resource ceilings: spend, token, and wake-rate limits per wake and per period, plus a hard brake.
- Escalate environment-level failures (broken model binding, expired credentials, crash-looping controller, ceilings hit) to the founder through a kernel-owned path that does not depend on the controller.
- Resume or safely retry interrupted work using kernel-internal checkpoints of kernel operations (distinct from the excluded universal cursor schema for company data).
- Preserve the controller's freedom to decide which company routine handles the wake.
- Keep external effects behind the same attended or signed capability boundary.

### Explicit exclusions

- Universal workflow engine.
- Platform-defined business jobs.
- Provider-specific webhook models.
- Complex orchestration UI.

### Acceptance criteria

- The controller can wake on a schedule and modify its company files.
- The reason for every wake is reconstructable.
- Restarting the kernel does not silently lose or duplicate durable work.
- A wake does not grant broader authority than the routine already has.
- Two overlapping wake causes result in serialized execution, not concurrent mutation.
- A runaway controller hits a ceiling and the founder is notified without the controller's cooperation.

## 7. Build 5 - Environment operations

### Purpose

Operate on the company environment itself while preserving the distinction between environment capabilities and business behavior.

### Initial operations

- Snapshot (quiescing the controller first).
- Restore.
- Export.
- Import.
- Fork.
- Trail playback (deterministic inspection of the record; re-execution with new intelligence is fork-and-run, not a playback mode).
- Pause and resume controller execution.
- Bind and unbind models and generic external capabilities.
- Founder-authenticated policy mutation.
- Recover from interrupted kernel operations.
- Erase a company.

Build 1 already proved export→inspect→import; this build completes the family on that substrate. Every snapshot and export carries the environment contract version; Base upgrade/migration across contract versions is an environment operation (tooling beyond contract stamping may be deferred, the stamp may not).

### Fork semantics

A fork copies selected company files, Git history, and durable execution record. It does not inherit:

- Credentials or private keys.
- Active external account bindings.
- Scheduled execution.
- Webhook ownership.
- External identity.
- Standing outward authority.
- The original's environment identity (a fork receives a fresh one).
- Signature grants (content-hash approvals are grants within an environment and do not transfer).

The fork records its lineage and may reinterpret inherited work with different intelligence.

### Explicit exclusions

- Business restructuring logic.
- Automatic provider rebinding.
- Platform-defined migration of company schemas.
- Cloud marketplace behavior.

### Acceptance criteria

- A snapshot restores the same environment state, including live databases, because snapshot quiesced the controller.
- An export can be inspected independently of the running installation.
- A fork preserves useful company history and available process records.
- A fork cannot act through the original company's authority, identity, or signature grants.
- Erasure removes referenced payloads without rewriting the append-only record.
- Environment operations are kernel-owned and recorded without interpreting business content.

## 8. Optional kernel modules and deferred refinements

**Optional kernel modules** — kernel-necessary when wanted, but not universal, so off by default and outside the minimum:

- MCP server surface (external agent hosts using approved company capabilities).
- Inbound webhook / listening capability.

**Deferred refinements** — may become valuable, but not part of the minimum Base plan:

- Typed disclosure, identity, money, and irreversible connector operations beyond the existing coarse authority boundary.
- Shared bridge SDK.
- Bridge or connector marketplace.
- Qorpera-maintained provider bridges.
- Optimized content-addressed artifact storage beyond what trail payload-by-reference requires.
- Generic synchronization databases.
- Provider-neutral normalized resource schemas.
- Cloud multi-tenant orchestration.
- Regional hosting and dedicated bridge isolation.
- Automated Nordea or other bank integrations.
- Base-version migration tooling beyond contract-version stamping.

Deferred refinements are promoted into Base only when repeated company experience shows that controllers cannot safely construct the capability from files, code, MCP, secret references, and generic network access. Optional kernel modules are added when a company wants them — they were never constructible by controllers in the first place.

## 9. Implementation discipline

- Start from current `master` in a fresh worktree.
- Read and preserve the current authority and company-folder boundaries from merged PRs.
- Keep the folder primary and the UI secondary.
- Avoid new mandatory company schemas.
- Prefer existing trail and tool seams before adding new platform stores or buses.
- Do not expose credentials to company-authored processes — references only, kernel-dereferenced.
- Do not use real credentials in tests.
- Use faux MCP servers and sandbox fixtures.
- Record failures and interruptions, not only successes.
- Test environment-operation recovery paths before claiming portability.
- Keep provider examples out of the generic implementation.
- Run the repository's required checks and focused tests for each code change.

## 10. Change-control question

Before adding any Base feature, answer:

> Does every sufficiently capable company controller need the platform to provide this securely, or could the controller construct it from ordinary files, code, and generic capabilities?

- If the controller can construct it: defer it to the company.
- If the controller cannot safely construct it and every company needs it: minimum Base.
- If the controller cannot safely construct it but not every company needs it: optional kernel module, off by default. Deferring this class "to the company" is impossible by definition.

## 11. Overall completion condition

The minimum Base is complete when a controller can durably operate arbitrary company files, build and run its own capabilities safely, contact the outside world through generic controlled means, continue through time under kernel-owned serialization and ceilings, and subject the complete company environment to snapshot, restore, export, playback, and fork operations — while the kernel guarantees policy provenance, an append-only trail, reference-only secrets, and founder escalation that survives a broken controller.
