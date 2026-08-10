# Qorpera Base Decision Record

**Status:** Build 0 deliverable, awaiting founder ratification
**Date:** 2026-08-10
**Companion documents:** `QORPERA-BASE-ARCHITECTURE-MANIFESTO.md`, `QORPERA-BASE-BUILD-PLAN.md`

## Definitions

**Company folder.** An ordinary, durable, agent-writable working directory and Git repository that *is* the company. It carries a narrow platform spine (`company.md`, `authority.toml`, `trail/`, `inbox/`, `app/`, `.qorpera/`) and anything else the controller creates. It is primary: no UI, database, or platform store may become the real company behind it.

**Company environment.** The company folder plus the kernel-owned state required to run it: bound models and credentials, schedules, runtime metadata, and the environment's contract version and identity. The environment — not just the folder — is what snapshot, export, and fork operate on.

**Durable trail.** The kernel-append-only record of controller execution: inputs and outputs, provider-exposed thinking blocks and reasoning summaries, tool calls and results, model and provider identity, errors and retries, kernel-observed effects, and authority decisions. Stored as documented, versioned, self-describing plain files inside the exportable environment. Never lossily compacted; large payloads content-addressed and referenced so retention and legal erasure delete payloads without rewriting the record. Stored record ≠ model context: nothing enters an agent's context merely because it was stored.

**Agentic controller.** The model-driven process that owns company meaning. Free to read and write arbitrary company files, build and replace schemas, ontologies, programs, tools, and connections, and publish views — with exactly two edges: it cannot mutate effect-gating policy or its own trail, and it cannot grant itself capabilities the kernel has not bound.

**Trusted kernel.** The small environment around the folder, analogous to an operating system: sandbox, secrets, network/effect boundary, time and events, environment operations, and environment integrity (policy provenance, trail append-only enforcement, single-writer serialization, resource ceilings, founder escalation). It supplies powers and isolation; it never manages the company or interprets business data.

**Capability.** A kernel-granted permission for a particular behavior to use a particular resource: a path scope, a secret reference, a network destination, an external operation. Secrets are opaque references dereferenced kernel-side; raw values never enter model context, the sandbox, or company files.

**Optional kernel module.** A capability the controller cannot safely construct for itself but that not every company needs — an MCP server surface, an inbound webhook listener. Off by default, added without imposing ontology. This is the third answer to the change-control question; deferring this class "to the company" is impossible by definition.

**Environment operation.** An operation on the company environment as a whole rather than a business operation inside it: create/open, start/stop/pause/resume, snapshot/restore (quiescing first), export/import, fork, trail playback, bind/unbind models and capabilities, schedule enable/suspend, interrupted-operation recovery, contract upgrade/migration, erasure, and founder-authenticated policy mutation. Trail playback is inspection, not re-execution; re-running with new intelligence is fork-and-run.

## Ratified decisions

1. **Minimalism is architectural, not aesthetic.** Base provides only what every agentic company needs and cannot safely self-construct, plus optional kernel modules for the kernel-necessary-but-niche class. Everything else is company-authored.
2. **Policy provenance.** `authority.toml` is founder-provenanced; the kernel verifies provenance before honoring gated effects. Controller or company-code writes to policy invalidate it at the effect boundary.
3. **The founder-decision channel is kernel-authenticated.** Approvals and ratifications cannot be forged by files appearing in `inbox/`.
4. **Trail integrity.** Kernel-append-only; no lossy compaction; payload-by-reference for growth and erasure.
5. **Secrets are references.** Kernel-side dereferencing at the trusted boundary is the mechanism; kernel-mediated rotation and OAuth refresh.
6. **Isolation honesty.** Sandbox claims are backed by named per-platform mechanisms or scoped down until they are.
7. **Single environment writer.** The kernel serializes wakes and sessions; queueing/coalescing policy is kernel-owned and recorded.
8. **Ceilings and escalation.** Kernel-owned spend/token/wake-rate ceilings, a hard brake, and founder escalation that does not depend on a functioning controller.
9. **Portability proven first.** Build 1 ends with a demonstrated export→inspect→import round-trip; every export and snapshot carries the environment contract version.
10. **Fork severs authority.** No credentials, schedules, webhooks, external identity, standing authority, environment identity, or signature grants cross a fork; lineage is recorded.

## Explicitly deferred

**Optional kernel modules (build when a company wants them):** MCP server surface; inbound webhook/listening capability.

**Deferred refinements (promote only on repeated demonstrated need):** typed connector-effect handling beyond the coarse authority boundary; shared bridge SDK; bridge/connector marketplace; Qorpera-maintained provider bridges (Google Drive, Nordea, GitHub, banks); optimized content-addressed artifact storage beyond trail payload-by-reference; generic synchronization databases; provider-neutral normalized resource schemas; cloud multi-tenant orchestration; regional hosting and dedicated bridge isolation; Base-version migration tooling beyond contract-version stamping.
