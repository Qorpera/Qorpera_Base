# Qorpera Base Architecture Manifesto

**Status:** Ratification draft (review edits applied)
**Date:** 2026-08-10
**Purpose:** Define the minimally viable environment around a self-evolving company-file and explain why each Base responsibility belongs there.

## 1. Thesis

Qorpera Base is not a company brain. It is the minimally viable environment in which an agentic controller can compose and operate a company as files.

The governing order is:

```text
Agent -> company files -> selective user interface
```

The agent owns company meaning. The files are the durable company. The user interface is a selective projection over them.

Base must make this arrangement durable, executable, safe, autonomous, and portable. It must not define the company that intelligence builds inside it.

## 2. Why minimality is architectural

Qorpera is intended to improve as model intelligence improves.

If Base defines customers, projects, departments, accounts, workflows, connector records, or a universal company database, future intelligence inherits present-day assumptions as platform constraints. It must first escape Qorpera before it can build a better company.

Base should therefore provide only capabilities that nearly every agentic company needs and cannot safely create for itself:

- A durable company folder and history.
- A complete available execution record.
- An agentic controller.
- Isolated execution for company-authored code.
- Protected credentials and controlled contact with the outside world.
- Durable wakes and events.
- Environment operations over the company as a whole.
- Selective publication to the founder.
- Environment integrity: policy provenance, an honest trail, serialized environment access, resource ceilings, and founder escalation that does not depend on the controller.

Everything else should normally be built by the company controller from ordinary files, programs, tools, and generic capabilities.

Capabilities that a controller cannot safely construct for itself but that not every company needs are neither minimum Base nor company-authored. They are **optional kernel modules**: off by default, added without imposing company ontology. Examples include an MCP server surface and inbound webhook listeners.

## 3. The company folder

The company folder is an ordinary, durable, agent-writable working directory and Git repository.

Its narrow platform spine currently includes concepts such as:

```text
company/
  company.md          founder intent and company identity
  authority.toml      policy at the external effect boundary (founder-provenanced; see 3.1)
  trail/              durable controller execution (kernel-append-only; see 5)
  inbox/              founder and company communication (untrusted channel; see 3.2)
  app/                selectively published company interface
  .qorpera/           narrow protected runtime metadata (inventoried; see 3.3)
  ...anything the controller creates...
```

The controller may create any additional structure:

- Markdown and documents.
- SQLite or other databases.
- JSONL and binary files.
- Source code and executables.
- Schemas and migrations.
- Tools and routines.
- Connections and provider bridges.
- Indexes, embeddings, graphs, or ontologies.
- Imported source data and derived artifacts.

Base does not require these structures to follow a platform ontology.

The folder is primary. The UI never becomes the only way to inspect or operate the company, and Base never infers company meaning from the shape of the interface.

### 3.1 Policy provenance

`authority.toml` and any other effect-gating policy are read from the folder but are mutable only through a founder-authenticated environment operation. The kernel verifies policy provenance before honoring any gated effect. A policy edit that arrives any other way — controller write, company-authored code, imported content — renders the policy invalid at the effect boundary until the founder re-ratifies it. Without this rule, "the controller may write arbitrary company files" and "company behavior cannot change its own authority" contradict each other, and the effect boundary is decoration.

### 3.2 The founder-decision channel

Founder ↔ company communication shape is company-authorable. The exception is the founder-decision channel: authority approvals, policy ratifications, and environment-operation confirmations are kernel-authenticated end to end. A "founder response" that is merely a file in `inbox/` is data, not authority; injected or synthesized content must not be able to forge founder approval of a gated effect.

### 3.3 Protected runtime metadata

`.qorpera/` holds only kernel-owned runtime state, and its contents are explicitly inventoried by Base: what lives there, what is exported, what survives restore, and what a fork receives. Secrets never live in the company folder in raw form (see 7.1). The company/runtime-metadata boundary defines what export and fork mean, so it is a published contract, not an implementation detail.

## 4. The company environment

The company folder is surrounded by a small trusted environment:

```text
External world
      ^
      | controlled capabilities
      v
Foundation kernel
  - sandbox
  - secrets
  - network/effect boundary
  - time and events
  - environment operations
  - environment integrity (provenance, serialization, ceilings, escalation)
      ^
      |
Agentic controller <-> company folder
      |
      v
durable trail -> selective UI projection
```

The kernel is analogous to an operating system. It supplies powers and isolation. It does not manage the company or interpret its business data.

### 4.1 One writer at a time

The kernel serializes access to the environment. A scheduled wake, an interactive founder session, and an operation-completion event never produce two controller instances mutating the same company folder and databases concurrently. The controller cannot serialize its own instantiation; only the kernel can. Queueing and coalescing policy is kernel-owned and recorded in the trail.

### 4.2 Resource ceilings and the brake

An autonomous company spends money in a loop, and a malfunctioning controller cannot bound itself — it is the malfunction. The kernel owns spend, token, and wake-rate ceilings per wake and per period, plus a hard brake the founder can always reach. Pausing is not a substitute: pause assumes the founder notices.

### 4.3 Escalation that does not depend on the controller

When the environment itself fails — model binding broken, credentials expired mid-wake, controller crash-looping, ceilings hit — the kernel notifies the founder directly. The entity that reports a broken controller must not be the broken controller.

## 5. Persistence is not memory

Base maintains a durable record; it does not maintain compressed knowledge that every model is forced to read.

```text
Stored record != model context
```

Nothing enters an agent's context merely because it was stored. The controller decides what to inspect for a task and may build or replace its own retrieval systems.

The durable trail should preserve all process information made available by the model and runtime, subject to explicit privacy and retention policy:

- Inputs and outputs.
- Provider-exposed thinking blocks and reasoning summaries.
- Tool calls, arguments, and results.
- Model and provider identity.
- File operations and resulting changes.
- External effects observed by the kernel.
- Errors, retries, interruptions, and corrections.
- Authority decisions and founder responses.

Base should not require additional rationale for every decision when the provider-exposed process record is already available.

### 5.1 The trail is kernel-append-only

The controller reads its trail; only the kernel writes it. A controller that can rewrite its own record voids the honest-record promise to future intelligence and makes authority audits meaningless.

### 5.2 The trail is never lossily compacted

Trail growth is managed by retention policy and by storing large payloads content-addressed and referenced from the record — never by summarization. Payload-by-reference also resolves the erasure conflict: legal erasure and retention policy delete referenced payloads without rewriting the append-only record or Git history. Privacy and retention policy explicitly covers reasoning content, not only inputs and outputs.

### 5.3 The trail format is part of the exportable environment

The trail is documented, versioned, self-describing plain files inside the company environment. If the real company memory lived in an opaque platform store, the folder would no longer be primary.

Company data may be stored as ordinary files or databases chosen by the controller. Base should not introduce a universal artifact database, observation schema, or synchronization store until a universal environment requirement proves that ordinary company-controlled storage is insufficient. The trail is the one platform record, and 5.3 is the condition under which it is tolerable.

## 6. The agentic controller

The controller must be free to:

- Read and write arbitrary company files.
- Build and replace schemas and ontologies.
- Create backend programs and tools.
- Run deterministic or model-driven routines.
- Connect external systems.
- Revisit earlier evidence and mistakes.
- Rebuild previous work using newer intelligence.
- Publish selected views for the founder.

This freedom is the point of Base. The platform should not replace it with a catalog of approved company architectures.

The freedom has exactly two edges: the controller cannot mutate effect-gating policy or its own trail (3.1, 5.1), and it cannot grant itself capabilities the kernel has not bound.

## 7. Sandbox and trusted capabilities

Minimality cannot mean executing arbitrary generated code with the founder's complete machine authority.

Company-authored behavior runs outside the trusted kernel. It must not automatically inherit:

- Host filesystem access outside its assignment.
- Model, cloud, connector, or desktop credentials.
- Private signing keys.
- Unrestricted network access.
- Product repositories outside its role.
- The ability to change its own authority.

Base provides generic capabilities instead. A capability can permit a particular signed behavior to use a particular resource, credential, domain, path, or external operation.

Initially, this boundary may remain deliberately coarse. It is safer to gate all credentialed or unattended outward behavior than to build a premature universal taxonomy of connector effects.

Typed handling for identity, disclosure, money, and irreversible operations remains valuable as autonomy grows, but it should refine the generic effect boundary rather than define provider or company semantics.

### 7.1 Secrets are references, dereferenced by the kernel

Company-authored code and controller context receive only opaque secret references. The kernel dereferences them at the trusted boundary — injecting values into outbound requests kernel-side. Raw credential values never enter model context, the sandbox, prompts, ordinary trails, or company files. This is the mechanism, not an aspiration: every "be careful" alternative fails against prompt injection, and fails against fork semantics, because a controller that ever saw a raw token may have copied it into an ordinary file that a fork happily inherits. Credential lifecycle (rotation, OAuth refresh) is kernel-mediated: a refreshed token lands in the protected store through the kernel, never through sandbox write access to the vault.

### 7.2 Isolation strength is stated honestly, per platform

Sandbox claims are backed by a named enforcement mechanism on each supported platform, or scoped down until they are. A plain subprocess with a clean environment denies ambient credentials but does not confine filesystem or network access. Where OS-level confinement is not yet implemented, Base says so and the authority boundary gates accordingly — credential denial is real from day one, filesystem confinement is claimed only where enforced. Overclaiming isolation is worse than the gap itself.

## 8. Connectivity without a connector platform

Connections are things the company controller builds or adopts. Base supplies generic ways to reach them safely.

The minimum connectivity surface is:

- An MCP client so the controller can use external MCP servers, consuming the same secret-reference mechanism as everything else (MCP servers themselves increasingly require OAuth).
- Sandboxed local tools for services without MCP support.
- Protected secret references.
- Controlled network access.
- Durable recording of calls and effects.

An MCP server surface — letting external agent hosts use approved Qorpera company capabilities — is an **optional kernel module**, off by default and outside the minimum. It is kernel-necessary when wanted (a controller cannot safely expose itself to inbound callers), but not every company needs it, and it adds an inbound attack surface the minimum does not require.

The distinction is:

```text
MCP client = the company can use external tools
MCP server = external agents can use the company
```

An MCP server alone does not connect the company to its sources.

Base should not initially build Google Drive, Nordea, GitHub, or other provider bridges. A Nordea bridge is an example of what Qorpera's own company controller should be able to construct using files, code, secret references, network capabilities, and published bank protocols.

If repeated company experience later reveals a universally useful bridge SDK or shared catalog, it can be added as an optional capability rather than made part of the company model.

## 9. Time and events

A self-operating company must be able to continue without an interactive chat remaining open.

Base therefore needs a small durable mechanism to wake the controller:

- On a schedule.
- When a previous operation completes.
- When the founder responds through the inbox.
- After an interrupted process is safely retried.

Base records why the controller woke. The controller decides what the event means and which company routine should handle it.

Missed-wake policy is kernel-defined and trail-recorded: when the host was asleep or the environment paused, the kernel decides whether missed schedules coalesce, fire, or drop, and records what it decided.

Inbound external events (webhooks) require an inbound listening capability, which is a distinct capability class from outbound network access. It is an optional kernel module, not part of the minimum. Until it exists, wake causes are schedule, founder response, completion, and retry.

## 10. Environment operations

Environment operations are capabilities applied to the company environment as a whole rather than business operations inside the company.

They are a legitimate Base responsibility because an individual controller cannot safely or completely implement them from inside the environment it is operating on.

Environment operations include:

- Create and open a company.
- Start, stop, pause, and resume its controller.
- Snapshot and restore the environment. Snapshot quiesces the controller first: a live working tree plus mid-write databases is not a consistent snapshot.
- Export and import the company.
- Clone or fork the company.
- Inspect and play back its execution record (trail playback).
- Bind and unbind models, credentials, and external capabilities.
- Enable, suspend, and resume schedules or event sources.
- Recover from interrupted kernel operations.
- Upgrade or migrate the Base environment contract itself.
- Erase a company (the operational face of legal erasure).
- Mutate effect-gating policy with founder authentication (3.1).

**Trail playback is not re-execution.** Playback is deterministic inspection of the record — cheap, and part of the minimum. Re-running past work with new intelligence is fork-and-run, already covered by fork. There is no third operation that "replays without effects": it would be neither a reproduction (models are stochastic) nor an inspection, and Base does not promise it.

A company fork is the defining example of an environment operation. It copies the selected company files, history, and record so new intelligence can reinterpret them, while removing live credentials, schedules, webhooks, identity, and external authority. A fork receives a fresh environment identity. Signature grants — content-hash approvals of unattended behavior — are grants within an environment and do not transfer across fork; otherwise a fork would inherit pre-approved unattended outward behavior the moment credentials were rebound. A fork may understand its origin without being permitted to impersonate it.

Every snapshot and export records the environment contract version it requires. The real portability risk is not export format; it is a company exported from Base v3 imported into Base v9.

Environment operations must not become business workflow operations. Base may fork a company; it does not decide how that company should reorganize its sales team.

## 11. The UI is publication

The user interface is a small, selectively published view over the company files.

It is not:

- The company's backend.
- The mandatory route through company data.
- The definition of company structure.
- The complete set of capabilities available to the controller.
- A security boundary for unpublished data.

The existing projection contract should remain bounded to presentation. A better controller can replace its published views without migrating its underlying company composition.

## 12. Cloud interpretation

A hosted Qorpera company is a hosted company environment, not a hosted CRM or ERP instance.

The cloud offering supplies durable filesystem ownership, isolated compute, secrets, controlled networking, time and events, environment operations, and selective publication. The company controller supplies the company.

Cloud implementation may use volumes, object storage, databases, queues, or key-management services internally. Those infrastructure choices must not leak into a mandatory company ontology or prevent export of the company environment. Published views in a hosted environment sit behind an access boundary; the projection contract must not assume local trust.

## 13. The test for Base responsibility

For every proposed Base feature, ask:

> Does every sufficiently capable company controller need the platform to provide this securely, or could the controller construct it from ordinary files, code, and generic capabilities?

If the controller can construct it, Base should normally stay out of the way.

If the controller cannot safely construct it but not every company needs it, it becomes an optional kernel module — off by default, never imposing ontology. Deferring such a capability "to the company" is impossible by definition; the two-bucket version of this test produces the wrong answer for exactly this class.

Security and environment operations are the main exceptions to constructibility because the controller cannot safely grant itself authority over the host or reliably operate on the complete environment from within itself.

## 14. Governing invariants

1. The agent owns company semantics.
2. The company folder remains primary and free-form.
3. The UI is an explicit projection, never ontology.
4. Stored information is never automatically forced into model context.
5. Available model and runtime process records are retained as durable trail data.
6. Company-authored code runs outside the trusted kernel.
7. Credentials and host authority are kernel-owned capabilities.
8. External contact crosses a generic trusted boundary.
9. Provider-specific bridges are company capabilities unless repeated evidence proves they belong in Base.
10. MCP is interoperability at the edges, not an internal company model.
11. Environment operations act on the company environment, not its business ontology.
12. Forks do not inherit live external authority, environment identity, or signature grants.
13. Legal erasure and explicit retention policy override indefinite preservation, implemented by payload-by-reference so the record itself is never rewritten.
14. Base grows only when the controller cannot safely construct the required capability itself; kernel-necessary but non-universal capabilities become optional kernel modules.
15. Effect-gating policy is founder-provenanced; the kernel verifies provenance before honoring any gated effect.
16. The trail is kernel-append-only; the controller reads it and cannot rewrite it.
17. The kernel owns resource ceilings and founder escalation that do not depend on a functioning controller.
18. The kernel serializes environment access; there is one environment writer at a time.
19. Raw secret values never enter model context, the sandbox, or company files; secrets are kernel-dereferenced references.

## 15. Non-goals

Qorpera Base is not attempting to:

- Construct a universal company ontology.
- Build a universal connector or synchronization platform.
- Ship every provider bridge a company may need.
- Define how company data must be normalized or indexed.
- Compress the company into forced model memory.
- Put every persistent byte into Git.
- Make the UI the backend contract.
- Bind company operation to one model provider.
- Treat browser automation as a trustworthy foundation for consequential effects.
- Promise deterministic reproduction of stochastic model behavior.
- Claim isolation strength that no named mechanism enforces.

## 16. Success condition

Base succeeds when a more capable future controller can inherit the same company files and available execution record, understand what happened, discard current interpretations, construct new capabilities, and operate a better company without first escaping Qorpera's architecture — and when the environment around it cannot be silently subverted by the controller it hosts.
