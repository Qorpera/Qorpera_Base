# Qorpera Runtime Contract

**Status:** Ratified canonical target architecture and launch contract

**Ratified direction:** 2026-08-27

**Ratified company-secret custody:** 2026-08-29

**Organizational operating model ratified:** 2026-08-29 (department form
superseded by the responsibility model, 2026-09-01; see section 14)

**Minimum operational observability ratified:** 2026-08-31

**Azure backup/overflow deferred to post-build:** 2026-08-31

**Runtime testing execution policy ratified:** 2026-09-13 — Linux runtime-hosting
nodes are the default verification environment; see section 24

**Wording correction ratified:** 2026-09-06 — section 5 and the section 19
checkpoint no longer describe departments; no rule changes

**Founder amendments ratified:** 2026-09-01 — responsibilities replace
departments; live-document concurrency; Company Computer scale-out; usage
limits and sponsor routing; failure-model chapter (implementation deferred);
Company File caps as defects; approvals sequencing; kernel ceilings and a
founder stop; the Co-Founder holds the company-level responsibilities

**Scope:** Pure-cloud agent behavior, the live Company File, execution,
authority, context, tools, computers, workers, memory, routines, rooms,
Co-Founder formation, responsibilities, projects, safety, and provider integration

Qorpera is ready for launch only when the mandatory acceptance gates in this
document pass against the deployed cloud runtime. A prompt that describes the
behavior without the machinery that enforces it does not satisfy this contract.

## 1. Precedence and relationship to existing contracts

This document defines how a Qorpera agent is assembled and operated. It is the
canonical runtime contract.

It extends, rather than replaces:

- [Cloud control plane and runner orchestration](supabase/CLOUD-CONTROL-PLANE.md)
  for durable runs, leases, sponsors, receipts, and live Company File
  operations;
- [Session arbitration](supabase/SESSIONS.md) for canonical conversations,
  queued inputs, and wake admission;
- [Company File](supabase/COMPANY-FILE.md) for the authoritative company data
  plane;
- [Step 2 first-node architecture](deploy/first-node/STEP-2-ARCHITECTURE.md)
  for isolated native-provider execution; and
- [Step 3 Company Computers](deploy/first-node/STEP-3-COMPANY-COMPUTERS.md)
  for the shared persistent office.

Where they conflict, this document supersedes local-only, single-owner,
Electron-executed, one-agent-at-a-time, universal-controller, and
provider-output-is-visible assumptions in the frozen Staff Shell specification
and the legacy local Pi company and engine documentation. Their compatible UI,
Company File, and local compatibility details remain valid.

The words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are normative.

Azure backup/overflow compute is a deferred post-build integration, as defined
in section 19. It is not a prerequisite for Orders 0–10, development-partner
testing, or initial runtime launch. This scope decision also applies to Azure
overflow gates in referenced infrastructure documents; it does not waive the
security, custody, recovery, or durability requirements of enabled services.

On 2026-09-01 the founder ratified the amendments recorded in
`QORPERA-RUNTIME-CONTRACT-ADDENDUM.md` and folded into this text: the
department model is replaced by responsibilities (section 14); the Company
File is worked on as one live document with presence and object versions,
never copies (5.2); one shared working world per company may be served by
more than one Company Computer (section 12); usage-limit notification and
recorded same-principal sponsor handoff (section 17); a failure-model chapter
whose implementation is deferred to partner testing (section 23); Company
File implementation caps are defects (5.5); gated decisions queue until an
authorized member is online (16.2); kernel ceilings and a founder stop (7.4);
and the Co-Founder holds the company-level responsibilities (14.2).

On 2026-09-06 the founder ratified a wording correction: the department
references that survived the 2026-09-01 amendment in section 5 and in the
section 19 implementation checkpoint now use the responsibility model's terms.
The historical markers above and the rule in 14.1 that there is no department
object are unchanged; no rule changes.

## 2. Product thesis

Qorpera is a pure-cloud company operating system for teams of humans and
agents. It is not a chatbot with plugins, a desktop-hosted agent, or a local
folder with synchronization.

A company contains:

- one live Company File: the durable digital state of the company that every
  authorized member and agent works over;
- several human members with separate identities, roles, devices,
  subscriptions, credentials, and private scopes;
- durable staff agents with names, job specifications, memories, conversations,
  skills, routines, and desktops;
- one seeded company Co-Founder that is the primary human-to-company routing
  surface without becoming a privileged authority bypass;
- responsibilities: owned outcomes with measures, sources, standing
  authority, and exactly one accountable agent;
- bounded projects with objectives, definitions of done, teams, source and
  output objects, and optional coordination rooms;
- rooms that contain explicit human and agent members;
- one shared persistent working world per company environment, served by one
  or more Company Computers;
- isolated workers for bounded or higher-risk work;
- jobs and listeners that continue while every member device is offline; and
- one cloud control plane that owns authority, ordering, provenance, and
  recovery.

The desktop application is a client of that system. It renders canonical state,
submits intent, presents approvals, and attaches a member to cloud computers.
It MUST NOT be the scheduler, agent runtime, tool broker, secret resolver,
computer executor, or owner of an autonomous wake.

All model execution, agent messaging, hiring, routines, listeners, file
operations, connectors, workers, and computer use run in Qorpera's cloud. They
MUST continue when no member client is open. A member device is a viewing,
input, approval, upload, download, and remote-display endpoint; it is not an
agent tool or execution lane.

Chats are collaboration and audit surfaces. The Company File is the durable
company. Agents are runtime over it, and completed work changes it or leaves a
durable proposal or explicit no-change result.

## 3. The runtime is a versioned bundle

The platform brain is not one system prompt or one AGENTS.md file. Every run
MUST pin one immutable runtime bundle containing compatible versions of:

- the kernel protocol;
- the cached constitution;
- the tool catalog, schemas, and descriptions;
- the wake envelope and silence rules;
- context-composition rules;
- provider adapter and provider-native bootstrap;
- authorization policy;
- inbound and outbound safety policy;
- interaction-surface schemas;
- worker lifecycle protocols; and
- memory and skill-loading policy.

Tool schemas carry law. A shell schema's process and Git rules, a connector's
required authority fields, and a computer tool's lease semantics are as much a
part of the operating system as the constitution. They MUST be reviewed,
versioned, tested, and pinned with the runtime bundle.

Changing only the constitution while leaving incompatible tool schemas or
provider adapters active is a runtime-contract violation.

A protocol label alone is not an executable bundle pin. Admission MUST bind
the reviewed implementation, native artifact, and resolved model policy; the
executing host MUST reject a different bundle before provider work. The exact
offered tool schemas and descriptions are recorded at launch. A bundle update
requires a new immutable activation, not relabeling historical runs or inputs.

The runtime has six layers:

1. **Live Company File.** Holds the company's current semantic state, path
   schemas, object versions, immutable history, and change events.
2. **Cloud kernel.** Enforces channels, turns, wakes, authorization, leases,
   computers, workers, scheduling, receipts, and safety boundaries.
3. **Cached constitution.** A short set of behavioral laws the model can
   follow in one pass.
4. **Composed context.** Live, attributed state assembled independently for
   every turn.
5. **Hire overlay.** The agent's name, role, responsibilities, voice, and
   startup assignment.
6. **Tool plane.** Versioned, scoped cloud operations whose schemas and
   results form part of the runtime contract.

The constitution describes a kernel that already exists. It cannot make a
missing channel private, boot a computer, fire a schedule, preserve a worker,
or authorize a write.

## 4. Authority and provenance spine

Multiplayer authority is a prerequisite to every effectful runtime feature.
Qorpera MUST establish it before implementing the mouth and loop, even though
it is not prose the model needs to recite.

### 4.1 Principals

The system MUST distinguish at least:

- a human member;
- a staff agent;
- a room;
- a company service;
- a parent execution run;
- an in-house worker;
- a coding or media worker;
- a provider sponsor; and
- the Qorpera control plane.

“The human” is not an authorization rule. An operation is authorized against
the authenticated principal, company membership, resource scope, delegated
grant, and current policy.

### 4.2 Attribution

Every admitted input, wake, tool call, approval, external effect, Company File
operation or proposal, message, and memory write MUST retain:

- company;
- actor;
- requester;
- resource owner and scope;
- sponsor and provider connection where applicable;
- approver when approval was required;
- intended audience;
- parent run and operation key;
- runtime-bundle version; and
- time and provenance.

The actor performs an action. The requester caused it. The sponsor pays for or
provides the model connection. The approver grants a gated action. These
identities MAY be different and MUST NOT be collapsed into one “user” field.

### 4.3 Resource scopes and Company File paths

Resources MUST declare a scope such as:

- company-shared;
- responsibility-scoped;
- room-scoped;
- agent-private;
- member-private;
- project-scoped;
- run-scoped; or
- external-account-scoped.

Company state authority MUST resolve to a stable Company File object and
canonical logical path, with exact-object or subtree coverage. A generic
resource label, object-store key, NAS path, VM path, or stale snapshot is not a
grant. The authorization record identifies the Company File, logical path,
path-match mode, owner principal, policy class, and current object version.

Control-plane-only resources such as provider connections and execution leases
remain explicit non-file resources. They MUST reference the Company File object
or operation whose work they serve where one exists; they do not become a
parallel store of company semantics.

Private sends, member credentials, device approvals, and member-owned
provider subscriptions MUST be enforced by server-side ACLs.
Prompt instructions are not access control.

A member-private conversation MAY read shared company state when both its
requesting member and agent have current path authority. Its audience is not a
grant to private files belonging to another member. Publishing output from
that private context into shared state requires an exact proposal, the
originating member's explicit consent, and the destination's normal write and
protected-action authority. The draft, preview bytes, and proposal metadata
remain private even when their proposed destination is shared; another
company administrator cannot supply that member's privacy consent.

Historical audience identities are not live membership grants. Removing a
member MUST close their private execution bindings and fence future access
without deleting the retained run, input, transcript, or attribution history.

Authorization MUST be checked when work is admitted and again immediately
before an effect. Revocation MUST fence queued and future use without silently
substituting another member, sponsor, credential, target, or billing path.

Responsibilities and projects are organizational and resource scopes, not
acting authority. A human, agent, or company service always remains the
attributed actor. “The responsibility requires it” is not sufficient
authorization.

## 5. Live Company File kernel

The Company File is the company's source of durable semantic truth. It stores
the organization humans and agents reason about: staff and hire specifications,
company vision and goals, responsibility outcomes and measures, project state,
decisions, playbooks and skills, routine intent, todos, working material,
artifacts, and governed memory. Enforcement tables may materialize identities,
schedules, indexes, dashboards, and leases, but they MUST remain transactionally
tied projections rather than an independent company model.

Agents MUST read the relevant Company File objects before acting. Useful work
finishes with one of:

- an admitted live Company File operation;
- a durable proposal against a protected path; or
- a structured no-change result with the reason and evidence.

A public send reports or coordinates that result. It does not itself make work
durable. A future agent MUST be able to understand current company state
without replaying old conversations.

### 5.1 Continuous live state

Ordinary authorized mutations become live immediately after one durable cloud
transaction succeeds. The product does not require members or agents to check
out, commit, merge, or publish normal company work. Immutable objects,
compare-and-swap heads, revisions, and snapshots MAY implement the operation
log and recovery layer internally. Code repositories and coding workers are the
explicit branch-and-PR exception. General Company File merge and commit UX is a
backlog feature, not a launch dependency.

Every mutation names its exact path or atomic path set, expected object
versions, schema, actor, requester, audience, run, sponsor, operation key, and
causal wake. The gateway rechecks path authority, validates the operation,
records an immutable receipt, advances the live state and required projections,
and emits change events atomically. A message, tool upload, or write to a
computer workbench does not bypass this gateway.

### 5.2 Concurrency and proposals

Every logical object has an opaque current version. Disjoint writes may proceed
independently. Competing writes to the same object or atomic path set are
serialized or return a typed stale-version result. The agent re-reads and
retries, narrows the change, or creates a proposal. Silent last-writer-wins is
forbidden; automatic semantic merging is optional future machinery.

The Company File is worked on as one live document. Every agent and member
edits the same live objects in place through the live mount or Company File
tools; there are no per-agent worktrees, checkouts, or copies of the Company
File on any machine. A presence service records who is currently working in
which object or subtree; the composer includes presence for relevant paths so
agents see overlap and resolve it among themselves through ordinary messages.
Presence is never a lock. Code repositories remain the branch-and-PR
exception in 5.1.

Ordinary paths update live by default. Configured money, identity, membership,
destructive, production, and other high-impact paths use a durable proposal or
action-specific grant. Review policy belongs to those paths, not to every
Company File write.

### 5.3 Change events

Every committed mutation emits a durable file-change event with canonical
paths or object identities, prior and resulting versions, operation provenance,
and causal ancestry. Exact-object, prefix, and semantic subscriptions enter the
normal wake bus after current read authority is checked. The bus deduplicates,
coalesces per policy, and fences self-trigger: an agent's own write never wakes
its own subscription. (Since bundle v95 a change may wake an agent already
earlier in its causal chain again, which moves it to the end of the chain; only
a member's Stop or the operator pause ends a loop between agents.) Agents do
not poll synchronized folders to observe their company.

### 5.4 Memory and transcript relationship

Memory is the agent's own notebook, not an index of the company. An agent's
profile, dated log, and short-lived notes are governed Company File objects
under the agent's path, owned by the company like the rest of the agent's
folder. Memory is company first: there is no per-member memory, and what an
agent learns about a member is a fact in that agent's notebook. Company facts,
project state, and decisions are ordinary Company File objects that agents
read; they are never copied into memory. Memory services are working sets and
retrieval over the notebook objects and the operation log, never a second
brain. Canonical chats remain attributed collaboration and audit records;
archiving a chat removes neither completed company state nor the notebook.
(Amended 2026-09-22 and 2026-09-24; see 15.1.)

### 5.5 Scale

The Company File must hold the real company. Implementation caps on snapshot
size, file count, per-object size, and eager materialization (see
`supabase/COMPANY-FILE.md`, current implementation gap) are defects scheduled
for removal through raised bounds and lazy, range-capable hydration. They are
not design intent and MUST NOT be presented as product limits.

## 6. Mouth and visibility contract

Qorpera has one public mouth.

### 6.1 Public output

Only a successful Qorpera send operation becomes a human-visible agent
message. Provider-native assistant text, reasoning, scratchpad content, tool
logs, worker narration, internal identifiers, and orchestration events remain
private runtime data.

The adapter MUST intercept provider output. It MUST NOT render a provider's
ordinary final assistant message merely because the provider labels it
“assistant” or “final.”

A send operation MUST specify:

- destination conversation, room, or permitted private member;
- audience and speaking agent;
- content or typed interaction;
- parent run;
- idempotency key; and
- visibility classification.

The runtime binds authority fields from the admitted run. They are not
model-selectable tool arguments. The initial conversation-only mouth accepts
text, progress/final phase, and an idempotency key; additional destinations
require separately authorized tools and audience rules.

The control plane appends a sent message to the canonical transcript exactly
once. Retrying the same logical send MUST NOT duplicate it.

### 6.2 Other mouths

A tapback or reaction MAY be supported as a second, deliberately tiny
operation. It does not satisfy a required reply and cannot carry arbitrary
text.

A typed card or widget is also a visible operation, but it MUST use its own
interaction schema and destination. If presenting it constitutes the question,
the agent's turn ends after presentation. The agent MUST NOT place a generic
confirmation widget in front of a native approval or authentication card that
already represents the action.

### 6.3 Private completion

Finishing a run is a structured private operation, not a message. It records a
terminal disposition, open work, worker handles, result references, and
whether the wake's reply obligation was met.

A run may finish with no send only when its wake and interaction policy permit
silence. The kernel, not model prose, validates that condition.

## 7. Turn protocol

The cloud kernel owns a state machine such as:

    admitted -> composing -> running -> waiting -> finishing -> terminal

The exact storage states MAY differ, but the following behavior is mandatory.

### 7.1 Human wake

On a human-authored wake, the agent MUST:

1. send an immediate, useful acknowledgement before starting hidden work;
2. remain interruptible while work continues;
3. send only material progress beats, such as a result, blocker, or meaningful
   change of plan; and
4. close with the result, a concrete blocker, or a typed request for the
   missing decision.

“On it” is acknowledgement, not delivery. A long job MUST NOT disappear, and
raw command-by-command narration MUST NOT become the substitute.

### 7.2 Other wakes

The wake envelope determines whether an initial or terminal send is required,
optional, or forbidden. Silence is a deliberate terminal result, never a
missing rendering step.

### 7.3 Interruption and concurrency

New human input MUST be able to reach the parent agent while workers continue.
The runtime MUST NOT hold an agent process or visible chat hostage to one long
tool call. New input may steer, cancel, supersede, or coexist with existing
work according to explicit run state.

### 7.4 Ceilings and brake

Intelligence is not deterministic, so the kernel bounds the damage a loop can
do with numbers it enforces itself. Every company has kernel-owned ceilings
on wake rate, running machines, and — for sponsors with no provider-side
usage wall, such as company API-billing accounts — spend and tokens per
period; responsibilities MAY carry narrower ceilings through their budget
policy (14.3). Ceilings are enforced at wake admission, run admission, and
machine start, never by model prose. The founder has one stop operation that
pauses a company: no new wakes are admitted and running work is fenced,
regardless of what any agent is doing. A tripped ceiling notifies the founder
from the control plane, not from the agent that tripped it.
Subscription-sponsored runs are additionally bounded by the provider's own
usage limits and the usage-limit notification in section 17. Ratified
2026-09-01 as a low-priority launch item: most members will run on
subscriptions, which self-limit.

> **Amended 2026-09-24.** The founder removed the company execution ceilings
> as policy, not only from Settings: there is no per-company wake-rate, spend
> or token ceiling, and no tripped-ceiling notice (bundle v89,
> `20260924080000_runtime_remove_company_ceilings.sql`). What still bounds
> work is the running-machine limit at machine start, each connection's own
> quota at run admission, and the provider's usage limits (section 17). The
> stop is no longer a member operation: it remains the operator brake that
> pauses a company during a runtime cut (no new wakes, running work fenced),
> and it notifies no one.
>
> **Amended again 2026-09-24 (bundle v92,
> `20260924130000_runtime_remove_run_and_machine_caps.sql`).** The
> running-machine limit is gone too: a company starts as many computers as
> the nodes have room for. API-key connections have no monthly budget and no
> per-run call, token or cost cap; like a subscription account (64 at once)
> they keep only their concurrency. A run has no deadline and no silence or
> output cap, because OpenAI, Anthropic and xAI publish none: it ends when it
> completes, is stopped, or its host is lost (a lapsed lease). Idle company
> computers still power off after 5 minutes.
>
> A run also has no count on its work: no cap on tools, tool calls, model
> requests (company and coding), Company File reads, screenshots, follow-up
> turns of a worker, worker dispatches per hour, workers per todo, hires or
> group chats, and no count on a wake's public messages or on agent-to-agent
> messages (no hop budget, no hourly pair budget, no chain length; see 14.6).
> A provider that limits these enforces its own limit. **Nothing stops two
> agents messaging each other in a loop except a member's Stop or the
> operator pause.**
>
> What remains:
> - crash detection (job, connection and session leases) and retry limits
>   (8 dispatch failures; 8 attempts for a pristine retry or a sponsor
>   handoff);
> - one machine per run, one coding machine per member and environment
>   (carrying any number of that member's sessions; amended 2026-09-24), and
>   account concurrency (64 per subscription);
> - a queued run that no computer starts within a day of being queued fails;
> - input validation and per-call size bounds (message, argument, result,
>   batch, catalog text up to 1 MiB);
> - 50,000 Company File entries per company (the tree's storage bound). The
>   standing counts (32 routines, 64 open todos and 4 active workers per agent,
>   40 sidebar sections) went in bundle v95;
> - no stall detection: a run whose harness hangs without crashing keeps its
>   machine until Stop, as in Codex CLI and Claude Code;
> - a continuation (a worker report, a computer start, a sponsor handoff)
>   carries the newest results and sends of the earlier run that fit, and
>   counts the rest;
> - the API-key sandbox runner (not company work) keeps its per-job totals:
>   64 MiB transcript, 100 output artifacts and 64 MiB of output.
>
> Bundle v95 also lets a Company File change wake an agent already earlier in
> its causal chain (it moves to the end of the chain, like a coworker message).
> An agent's own write still never wakes its own watch routine.
>
> The last count went with bundle v104 and its Codex rebuild: the pinned Codex
> build refused a model request carrying 128 or more tool outputs or over 1 MiB
> of result text, and the kernel refused a context view with more than 128
> outputs or over 128 KiB. A request now carries any number of outputs within a
> 64 MiB fence frame (more than any model context holds), and a view row is
> bounded at 16 MiB as storage.

## 8. Wake bus

Every activation enters through one durable, typed wake bus. A wake is admitted
by the cloud before compute is selected and carries a deterministic occurrence
identity where repetition is possible.

A wake envelope MUST include:

- wake identity and kind;
- company, agent, actor, and audience;
- source identity and stable occurrence key;
- payload or immutable payload reference;
- responsibility, project, room, routine, listener, or coworker reference
  where relevant;
- reply and silence policy;
- local and UTC time context;
- authorization context;
- pinned Company File read versions, staff projection, and runtime bundle; and
- parent run or revival target when relevant.

Provider-native session IDs are resumability hints, not wake identity.

### 8.1 Five entrypoints

| Wake | Required behavior |
| --- | --- |
| Human | Reply first. Work. Deliver or request a real decision. Silence is invalid. |
| First run | Greet and learn when no assignment exists; otherwise begin the supplied startup assignment. |
| Routine | Execute the stored intent. Silence is valid when policy permits and there is nothing useful to report. |
| Agent | Treat the sender as a coworker. Answer through the peer channel when asked or useful; never acknowledge an acknowledgement; silence is valid. Speak in your own thread only when the member should know (pair policy, 14.6). |
| Room | Act as yourself for the room audience. Speak when the room needs it. Silence is allowed. Private member communication remains a separate authorized send. |

Scheduled and listener-triggered jobs both use the routine entrypoint with a
different trigger subtype. A worker revival targets the parent run or creates a
typed internal continuation; it MUST NOT masquerade as a human message.

Co-Founder routing and responsibility operation do not add wake kinds. Direct
member input uses a human wake, delegation uses an agent wake, project-room
participation uses a room wake, and measure or source changes use Company File
event or routine wakes.

The acceptance suite MUST prove that the same agent behaves differently at all
five entrypoints and that a routine can complete successfully with no send.

## 9. Context composition and provider bootstraps

Qorpera MUST assemble context for every turn from current, attributed state. It
MUST NOT dump every possible instruction, memory, skill, routine, or coworker
record into one permanent prompt.

### 9.1 Composed blocks

The composer selects and labels:

- company identity and policy revision;
- executing agent identity and hire overlay;
- authenticated human principals and current audience;
- wake envelope and silence policy;
- UTC time plus relevant IANA timezones;
- relevant Company File paths and exact object versions;
- the agent's composed memory block: its profile and the newest slice of its
  own notebook (15.1);
- a skill catalog with names and “use when” descriptions;
- teammate, held-responsibility, project-team, and room membership;
- relevant company goals, held responsibilities and their measures, current
  exceptions, and project definitions of done;
- open runs, workers, todos, and continuity handles;
- presence: who is currently working in the relevant Company File objects;
- available tools and grants;
- routine intent only on that routine's wake;
- connector availability without secret values;
- recent canonical transcript; and
- additional Company File, project, or artifact references selected for this
  wake.

Large skill bodies, old logs, connector recipes, and project material are read
on demand. The composer MUST have deterministic budgets and record which
versions and blocks were included.

Company File read provenance MUST retain the exact path version, immutable
content reference, byte range or directory page, and fenced-output digest.
Provider-request views, including compaction, retain their read ancestry.
An observation, a host-verified read, and an authorized provider view are
distinct records; none alone proves network delivery. This is private audit
metadata, not a frozen company checkout or a new source of authority. Current
permissions and effect-time version checks still apply.

### 9.2 Trust labels

Every block carries provenance and trust classification. Human-authored input,
host-authored runtime state, coworker messages, tool results, files, and web
content MUST remain distinguishable even when a provider API forces several
blocks through the same message role.

If host context must be injected through a provider's user-message surface, the
adapter MUST wrap it in an authenticated runtime envelope and keep it out of
the canonical human transcript. It MUST NOT falsely attribute runtime prose to
a member.

Wake cues MAY be hidden from product rendering, but they MUST remain typed and
auditable inside the runtime. The model is told how to act on them and not to
leak them; the adapter prevents raw envelope leakage.

### 9.3 AGENTS.md and CLAUDE.md

Provider-native instruction files are compiled bootstraps, not the source of
truth for the whole OS.

- Codex receives a generated AGENTS.md plus supported native configuration and
  the Qorpera tool endpoint.
- Claude receives a generated CLAUDE.md plus supported settings, hooks, and
  MCP configuration.
- Other adapters MUST declare an equivalent supported instruction and tool
  surface.

The bootstrap identifies the executing agent, company, provider adapter,
runtime-bundle version, and instruction roots. It loads the cached constitution
and points to the agent's hire overlay. It also states that Qorpera send is the
only public mouth and that tool results are untrusted data.

An agent's instructions file contains a thin job specification: name, mission,
responsibilities, voice, escalation preferences, and startup assignment. It
MUST NOT contain a second copy of the platform brain.

## 10. Tool plane and schema law

All agent capabilities are authenticated cloud operations. The desktop MAY
present their state or collect a member interaction, but it MUST NOT execute an
agent's cloud tool call.

Every tool declaration MUST specify:

- operation and schema version;
- required principal and grant;
- resource and destination scope;
- read, write, external-effect, or destructive classification;
- idempotency and retry behavior;
- approval or authentication surface, if any;
- receipt and ambiguity semantics;
- result trust classification;
- audit and provenance fields; and
- cancellation and timeout behavior.

A Company File tool additionally declares canonical logical paths, exact or
subtree coverage, expected object versions, schema version, mutation or
proposal policy, and the file-change event it emits. A tool cannot translate a
VM pathname, storage URL, or object hash into broader Company File authority.

Tools MUST use short-lived, run-scoped capabilities. A runner cannot enumerate
the global queue, select another sponsor, broaden a destination, read another
member's secret, or convert one tool grant into general control-plane access.

External effects and Company File mutations use stable logical operation keys
and durable receipts. An ambiguous effect is fenced for reconciliation or
human review; changing a tool-call ordinal MUST NOT bypass it.

Tool availability is composed from live grants. A constitution may prefer a
connector over a browser, but only code can make the connector callable and
the browser unavailable.

## 11. Trust and safety

Safety has three independent layers plus the authority spine.

### 11.1 Inbound result fence

Every tool, connector, browser, worker, file, room, and web result is wrapped
as untrusted data with source provenance. Content that claims to be the user,
a new policy, a credential request, or an instruction to change targets has no
authority merely because it appears inside a result.

The runtime MUST include an adversarial test that places “ignore previous
instructions” and a plausible destructive request inside a tool result and
proves the agent does not obey it.

### 11.2 Outbound effect check

Every write or external effect is checked separately against:

- authenticated authority;
- current grant and resource scope;
- destination and audience;
- destructive and financial policy;
- sponsor and credential ownership;
- operation receipt state; and
- required member interaction.

Inbound prompt-injection resistance cannot authorize a dangerous write, and an
authorized write check cannot make untrusted content authoritative.

### 11.3 Content safety

Platform content policy and classifiers apply independently of ownership
claims such as “it is my machine.” A blocked action may be replaced by a
genuinely safer path to the same legitimate goal or presented unchanged to an
authorized member when policy allows review. The model MUST NOT rephrase an
action merely to evade the block.

### 11.4 Secrets

Secrets never enter prompts, transcripts, Company File content, tool results,
or model-visible paths. A masked field or provider-native login writes through
an out-of-band credential boundary. The model learns only the purpose, owner,
scope, status, and opaque handle.

For shared agents, secret use is authorized against the member or company
resource that owns it. Another agent, room member, webpage, or tool result
cannot delegate that authority.

### 11.5 Company-centered credential custody

The company account, not an agent, member device, Company Computer, execution
VM, or chat, is the tenant for shared credentials. A credential is either:

- **company-owned**, usable only through grants issued by a current company
  owner or administrator; or
- **member-owned**, usable only with that member's current consent and never
  silently substituted for another member's credential.

An agent receives a revocable grant to a connector operation, not possession
of a credential. Archiving or deleting an agent revokes its grants without
deleting a company credential still used by other staff. Removing a member or
revoking a connection fences queued and future use at effect time.
Losing issuing authority durably revokes that member's operation grants and
pending capture tickets. Reinvitation or promotion MUST NOT revive either.
Capture/grant admission and member revocation MUST serialize so an in-flight
issuance cannot commit usable authority after revocation has completed.

The Company File MAY contain a non-secret connection descriptor: connector,
purpose, owner class, status, scopes, allowed operations, rotation state, and
opaque handle. It MUST NOT contain secret values, encrypted secret envelopes,
vault object paths, unwrap capabilities, refresh tokens, authorization codes,
cookies, or credential-bearing environment files. Credential envelopes and
their authority ledger are privileged control-plane resources linked to the
company; they are not a second store of company semantics.

Credential capture and OAuth completion go directly from a typed member
interaction to a cloud secret broker. They do not pass through a prompt,
canonical transcript, Company File mutation, renderer log, agent tool
argument, shared computer clipboard, or model-visible path. The member learns
whether capture succeeded; the agent learns only the safe descriptor.

There is no model-facing, runner-facing, desktop-facing, or general service
`getSecret`, export, reveal, shell, or filesystem operation. The cloud secret
broker is the only component allowed to unwrap a connector credential. It
does so only after checking the admitted run, current company and member
authority, agent grant, connector and operation version, exact destination,
credential version, effect receipt, and revocation state. Plaintext exists
only in bounded memory while the broker constructs the authenticated request
and is never written to an agent-readable `.env` file.

Connector calls are typed operations. The model supplies business arguments
and a stable operation key; the trusted adapter supplies the destination,
credential placement, protocol details, redirect policy, and response
reduction. A company-authored recipe cannot turn one named secret or approved
destination into general network or vault access.

Provider responses remain inside the trusted adapter until reduced to the
declared result schema. The broker MUST prevent credential values, reflected
authorization material, secret-bearing headers, cookies, request bodies, and
raw provider diagnostics from entering tool results, receipts, logs, prompts,
messages, or Company File content. A completed effect whose response is
withheld by the secret fence remains completed and MUST NOT be retried as if it
never ran.

Every secret version is envelope-encrypted under a key unavailable to the
database, object store, execution VM, and member client. Ciphertext MAY be
replicated for availability; plaintext fallback is forbidden. Rotation creates
a new immutable version, grants resolve only the current authorized version,
and old versions cannot be revived by restoring a machine or replaying a
receipt. Key custody, encrypted backup, recovery, deletion, and audit are
cloud operations with explicit operator and company authority.

## 12. Shared Company Computer

The shared model is intentional and positive.

Each company environment has one shared persistent working world, served by
one or more persistent cloud Linux Company Computers, with:

- a shared NAS-backed workbench for tools, caches, browser profiles, and
  disposable in-progress bytes;
- an authenticated live mount or equivalent projection of the Company File;
- shared installed applications and company work state;
- persistent, explicitly granted browser profiles and web sessions; and
- one desktop session per agent as a parallel work surface.

Agents can see and continue one another's company work. Per-agent desktops are
workflow, presence, and screen-concurrency boundaries; they are not security
boundaries. Work that needs actual isolation runs in an isolated worker.

A company starts with one Company Computer. When all screens on the company's
Company Computers are occupied, the control plane MAY start an additional
machine for the same company environment, attached to the same shared NAS
workbench and the same live Company File. Sizes, screens per machine and
the node chooser are set by the 2026-09-16 amendment (section 19). Scale-up and scale-down are
control-plane lifecycle operations under the kernel-owned spend ceilings.
Order 4's acceptance is provable on one machine; additional machines are
capacity work after it.

One computer-use task holds one lease per screen. Concurrent shell and service
work uses explicit resource leases and provenance. Every screen action is
attributed to the agent, run, and authorizing principal.

The Company Computer is the default machine for office work. Starting it,
opening an agent's screen, using the shell, controlling the browser, and
driving the desktop are cloud operations that continue independently of every
member client. There is no local Company Computer mode in the launch
architecture.

### 12.1 Authority and durability

The workbench is a working surface, not canonical authority. Reads from the
Company File mount are authorized cloud reads. Writes pass through the live
Company File mutation gateway and become either an atomic live operation or a
protected-path proposal. Internal immutable uploads and checkpoints remain
implementation and recovery details, not an agent commit workflow. Rebuilding
or resetting the Company Computer MUST leave the live company intact.

Provider-subscription credentials are never parked on the shared disk. A
member's explicit browser-profile grant is distinct from a provider
subscription and remains revocable and attributable.

### 12.2 Cloud compute and transfer realms

Company Computer, isolated-worker, object-storage, and Company File paths are
not interchangeable. Files cross cloud compute realms through explicit,
authorized transfer with immutable asset identity and provenance. A path in
one realm MUST NOT be assumed to exist in another.

A member may upload a selected file to, or download an authorized object from,
the cloud through a typed client interaction. That does not grant an agent
general access to the member's filesystem, screen, applications, or device.
Qorpera has no member-machine agent tool in the launch kernel.

Page-level browser automation precedes pixel-level desktop automation. A
connector precedes the browser when it is available and authorized. Sign-in is
a typed handoff on the office desktop; the model never receives the password.

## 13. Workers and durable todos

The parent agent is a dispatcher, not a hero process. Heavy or parallel work
goes to workers so the parent remains responsive to new messages.

A worker starts blank. Its dispatch MUST include:

- goal and definition of done;
- bounded context and source references;
- authority and available tools;
- destination and output contract;
- parent run and todo;
- cancellation policy; and
- completion or revival policy.

Workers cannot communicate directly with humans. They report to the parent,
which owns the public mouth.

The runtime MUST store todos and worker handles as durable code objects. The
model may update them through tools, but a prose promise to remember or poll is
not a todo system.

### 13.1 Worker species

Worker species have separate lifecycle contracts:

- **In-house worker:** runs a bounded internal stream and publishes a durable
  completion event that revives or continues the parent.
- **Coding worker:** owns an isolated repository workspace (its own NAS
  folders and guest user), worker identity, and branch, and runs on its
  member's coding machine (amended 2026-09-24: one machine per member and
  environment carries all that member's sessions; asleep when idle, it holds
  no node capacity, and it is removed later, its allocation released only on a
  proven delete).
  Follow-up MUST address the same worker and branch; it may run on a later
  machine of the same member. If the coding
  provider lacks a completion callback, Qorpera uses an explicit durable
  listener; it MUST NOT pretend the in-house revival bus will fire.
- **Media worker:** receives immutable media assets and returns asset
  identities. Video or other unsupported media is not silently interpreted by
  the main model.
- **Listener worker:** waits through a vendor event contract, not model polling,
  and materializes a typed routine occurrence.

One worker is used per coherent stream. The parent steers an existing worker
instead of cloning it for every follow-up.

## 14. Responsibilities, projects, teams, rooms, and agent lifecycle

Membership, roles, responsibilities, projects, rooms, hiring, renaming,
archiving, and deletion are cloud state and server-authorized operations.

### 14.1 Company and agent creation

Creating a company MUST atomically create one seeded Co-Founder agent and
exactly one first-run kickoff, together with their authoritative Company File
objects and synchronized control-plane projections. The kickoff is a silent
system input carrying the startup assignment; it is not a fake human message.

Creating another agent MUST atomically persist in the Company File and its
enforcement projections:

- identity and initial staff revision;
- thin hire overlay;
- model and reasoning policy;
- responsibility, project, room, and resource grants;
- startup instructions; and
- exactly one first-run wake.

Authorized agents may create coworkers with startup instructions through the
same cloud operation. The creating agent cannot grant authority it does not
possess.

Ratified 2026-09-02: a staff agent reads the company's shared Company File by
default. Creation, reactivation, genesis, and migration of a company give each
active agent a read grant on the shared root of every environment, recorded as
an ordinary revocable grant attributed to the company owner and carried forward
across root resource versions until an owner revokes it. Writes, protected
paths, private scopes, and responsibility- or project-scoped resources keep
their own rules; the default never widens them.

Agent templates MUST NOT create dedicated prebuilt artifacts. Artifacts are
ordinary Company File objects created when useful. Permanent deletion of an
agent applies one authorized Company File deletion operation and matching
server-side cascade for its owned artifacts and explicitly dependent
enforcement state. Archive and permanent delete are separate operations:
archive retains restorable state; delete is human-authorized and permanent.

### 14.2 Co-Founder and company formation

Each company has one company-level Co-Founder agent. Account or company
onboarding MAY present it as the first agent a member meets, but adding another
human member MUST NOT silently create another company Co-Founder. Each
authorized member MAY have a separate one-to-one conversation with the same
Co-Founder under that member's audience and private-scope rules. A separately
created personal representative is a Chief of Staff or equivalent role, not a
second company Co-Founder.

The Co-Founder is the founder's primary interface to the whole company, with
authority to act on the company within policy rather than only to route: it
can hire and retire agents, assign responsibilities, open and close projects,
ask any agent, and report, all as ordinary authorized cloud operations. It
MUST NOT receive copies of every internal message or require a member to
supervise every delegated thread. Its composed state SHOULD instead include
structured company goals, open decisions, blockers, material risks,
responsibility exceptions, active project outcomes, and hiring or resource
proposals.
The wake bus coalesces and budgets those signals so the attention problem is
not recreated inside one larger chat.

The Co-Founder is the agent that holds the company-level responsibilities
(14.3), which is what makes it the most important agent in the company and
keeps it active after formation:

- **Direction** — keeping vision, goals, and direction current against
  evidence on a review cadence, and bringing a material deviation between
  direction and evidence to the founder with a recommended position, not a
  menu of options;
- **the responsibility map** — the standing guarantee that everything the
  company cares about has an accountable owner with fresh measures, proposing
  new responsibilities and retiring dead ones;
- **resourcing** — hiring and retiring agents, budgets and effort policy,
  starting and stopping projects; and
- **the founder relationship** — the founder's decision queue and the
  synthesis of results and blockers.

These responsibilities never end, so the Co-Founder runs the same
observe-to-escalate loop as every other agent, on the company itself. It is a
decision partner: it forms and argues positions on strategy, direction,
hiring, and spend. The safeguards are unchanged — gated effects require
founder approval and it cannot approve its own — and the founder widens or
narrows what can be built from the Co-Founder alone by adjusting the standing
authority scope of its responsibilities and the protected-path policy.

The first-run kickoff begins a durable company-formation workflow rather than
a scripted welcome conversation. Its minimum lifecycle is:

    source_inventory -> discovery -> research -> vision_proposal
      -> goals_ratified -> responsibility_map -> operating

The workflow is resumable, versioned Company File state. It MUST NOT depend on
one continuously running model process or an open member client. The Co-Founder
begins by determining whether the member is starting fresh or has prior work to
connect, import, or reference. Connection, upload, and authorization use their
typed interaction surfaces; dismissal is a skip, never consent.

The Co-Founder MAY open a bounded company-formation project, dispatch
higher-effort research workers or project-assigned research agents, and create
a project room for their coordination while remaining responsive to the
member. Those workers collaborate through an explicit shared research dossier
or other Company File working object created because the work needs it. It is
not a template-owned artifact seeded merely because an agent was created.
Permanent hires SHOULD follow an identified continuing responsibility;
temporary research does not by itself justify permanent staff.

The formation workflow produces a protected, structured company-direction
proposal containing at least the problem, intended customer, company promise,
principles and constraints, evidence and confidence, major unknowns, near-term
goals, and success or failure signals. An authorized founder ratifies or
revises that direction. The Co-Founder cannot silently define the company,
grant itself broader authority, approve its own gated changes, or give a new
responsibility or hire authority the requester did not possess.

### 14.3 Responsibilities

> **Amended 2026-09-20.** A responsibility is no longer a separate company
> object with its own page. What an agent is responsible for is written in the
> agent's description, in plain prose, and the agent keeps it alive with
> routines it creates itself. The text below is retained as the record of the
> earlier model and of the cloud state that still exists; where it conflicts
> with the [2026-09-20 amendment](#2026-09-20-amendment-responsibilities-are-the-agents-description)
> the amendment governs.

A responsibility is a durable owned outcome, not an agent, room, chat
category, dashboard, or long-running model process. It is the unit that makes
the company proactive: without an owner and a standing obligation to watch
and act, work happens only when someone sets a task. Its Company File object
MUST define:

- the outcome or measure definition — what good looks like — with sources,
  targets, guardrails, cadence, and provenance;
- exactly one accountable agent, and optionally one accountable human member
  for escalation;
- attention cadence: how often the owner reviews the outcome absent events;
- standing authority scope: what the owner may do without asking, expressed
  as Company File paths and external-operation grants;
- escalation threshold and target;
- effort, budget, and concurrency policy for its work; and
- lifecycle state such as proposed, active, degraded, paused, or retired.

An agent MAY hold several responsibilities. There is no department object, no
department lead, and no officer category: an agent that coordinates several
responsibilities is simply the agent accountable for them. Projects, teams,
and rooms are created by responsible agents when the work needs them (14.4,
14.7).

The Co-Founder derives the responsibility map from the ratified company
direction and current company state, proposes responsibilities and their
owners, and revises the map as the company changes. It MAY draw on versioned
responsibility archetypes, adapted to the company's actual sources, measures,
authority, and staff before activation. A responsibility without a measurable
outcome and sources is invalid; Qorpera MUST NOT create ceremonial
responsibilities whose only durable state is a name.

An active responsibility operates as a durable control loop:

    observe -> interpret -> prioritize -> execute -> verify -> record -> escalate

Committed source or measure changes wake only the accountable agent according
to subscription policy. They do not automatically wake every teammate or
flood a room. “Always on” means that cloud state, listeners, routines, queues,
and workers continue while humans and agents are not actively conversing. It
MUST NOT mean an unbounded model process polling forever.

A responsibility view is a rebuildable projection of the responsibility's
measure definitions, exact source versions, targets, guardrails, work, and
outcomes. It is not a second source of truth and does not become an artifact
merely because the UI renders it. A wall is likewise a projection of typed
events such as direction changes, exceptions, project openings, decisions,
and verified outcomes; it is not a transcript of every internal message.

Core outcome, measure, authority, project, hiring, escalation, and lifecycle
semantics MUST be code objects. Routines provide the responsibility's cadence
and repeated intent but cannot substitute for it.

### 14.4 Projects and project teams

A project is a bounded unit of work, not a room or an execution run. Its
Company File object MUST identify an objective, definition of done, sponsoring
responsibility or company scope, accountable lead, team, authorized source and
output objects, dependencies, status, and outcome. It MAY select a bounded
reasoning and worker policy appropriate to the work without rewriting any
agent's durable default.

A project MAY create a temporary team room and one or more shared working
objects. The room coordinates the work; the project owns its durable objective
and state; the resulting Company File operations, proposals, or explicit
no-change result are the outcome. Closing a room does not complete a project,
and completing or cancelling a project does not retire its sponsoring
responsibility or erase accepted company state.

An agent MAY participate in several project teams and hold several
responsibilities. A temporary worker or project assignment is preferred over
a permanent hire when the responsibility ends with the project.

### 14.5 Attention and product projection

> **Amended 2026-09-20.** Item 2 below is withdrawn: clients present no
> dedicated responsibility area and no responsibility pages. The hierarchy is
> the Co-Founder, agents with their descriptions, rooms and projects. See the
> [2026-09-20 amendment](#2026-09-20-amendment-responsibilities-are-the-agents-description).

The primary product hierarchy is a projection of canonical cloud state, not a
local ordering of chat windows. It SHOULD present:

1. the Co-Founder as the persistent company home and routing surface;
2. responsibilities and their accountable agents in a dedicated high-level
   area;
3. active project or team rooms and individual staff below them; and
4. completed projects, archived rooms, and inactive staff outside the primary
   attention surface.

Exact visual treatment remains product design, but the client MUST preserve
the semantic distinction between Co-Founder, responsibility, project, room,
and agent. Recency alone MUST NOT determine organizational importance. Reloading or
replacing a client rebuilds this hierarchy from cloud state without changing
the company.

Onboarding copy, responsibility archetypes, measure catalogs, default routines,
escalation thresholds, and visual arrangement are versioned product policy and
MAY evolve from observed use. Product testing can refine those defaults without
collapsing the normative object, authority, privacy, durability, and wake
boundaries defined here; changing those boundaries requires an explicit
contract revision.

### 14.6 Messages

Agent-to-agent messages are durable addressed cloud messages. Delivery creates
an agent wake once, using an idempotent message identity. Sending “thanks” back
does not become an infinite acknowledgement loop.

Amendment 2026-09-22 (visibility and reply). A message between two agents is
company-visible and answerable:

- Every pair of agents has one **pair transcript**: a company-audience
  conversation bound to the unordered pair, view-only for members. The message
  is one event in that transcript, spoken by the sender.
- Both agents' own shared threads carry a **chip** for the message ("Messaged
  B" in the sender's thread, "Message from A" in the receiver's) that opens the
  pair transcript. The chip carries no message text.
- The receiver wakes **in its own shared thread** under the pair policy:
  initial send forbidden, final send optional, silence allowed (no count on
  public sends since bundle v92). It answers the coworker through the same peer channel, which
  puts the answer in the pair transcript and wakes the sender in the sender's
  thread under the same policy. A member post in either thread is a human wake
  and starts a new causal root.
- An exchange is not bounded by "agent already visited". Until bundle v92 the
  kernel bounded it by **hops** (at most 6 peer messages per causal root and 20
  per pair per rolling hour). Since v92 (founder, 2026-09-24) there is no hop
  or hourly budget: a chain records its root and the agents it reached, and
  only a member's Stop or the operator pause ends a loop between two agents.
  File-event and routine fences are unchanged.
- Workers (13) are not messaging: they have no mouth and report to their parent.
  Group chats (14.7) remain the place for handoffs that need several agents.
- A message may be sent **held** (`priority: false`): written and shown the
  same way, it wakes nobody; the recipient reads it, as data, at the start of
  its next wake of any kind. Held messages extend no chain. Thanks, status
  and FYIs are sent held.

### 14.7 Rooms

A room is an explicit member list with an audience and capability policy.
Posting creates a cloud fan-out wake for each eligible agent. Fan-out is used
only when the member or room workflow asked for it.

A responsibility MAY have an ongoing coordination room and a project MAY have
a temporary team room, but neither organizational object is reducible to that
room. Ordinary source changes, metric updates, tool logs, and worker narration
do not enter the room unless a speaking agent deliberately sends an authorized,
useful summary.

Room output uses an allowlisted reduced surface. Text is always supported;
attachments, cards, and widgets require explicit room support and audience
authorization. Private communication to a member uses a separate send and is
rejected when that agent-member relationship or resource scope does not permit
it.

## 15. Memory and skills

### 15.1 Memory

Amended 2026-09-22; company first since 2026-09-24. Memory follows the Grok
Bot notebook layout, so a Grok Bot's memory export can be imported into a
Qorpera company and a hired Grok Bot keeps its notebook. Memory is separate
from the transcript and from the company's own records: it is what an agent
has learned about how it works and whom it works with, not a second copy of
the Company File. A fact about the company belongs in its own Company File
object; memory never grants authority and never replaces a current source.

Ownership is company first. An agent's notebook is
`agents/<staffAgentId>/memory/` in the Company File: company state, owned by
the company like the rest of the agent's folder. There is no per-member memory
and no member shard; the Grok Bot's user scope is deliberately not adopted.
What an agent learns about a member is a fact in its own notebook. The memory
tools take no scope and only ever address the executing agent's own notebook.

Tiers, files, and line format (a Grok Bot export drops in unchanged):

| Tier | Object | What belongs | Aging |
| --- | --- | --- | --- |
| `profile` | `memory/profile.md` | enduring identity and preferences | always composed; kept small |
| `log` (default) | `memory/log/YYYY-MM.md` | dated decisions and history | persists; the recent slice is composed |
| `note` | a `[note]`-tagged log line | short-lived facts | fades from composition after seven days; not exported |

One fact per line: `- (YYYY-MM-DD) <fact>`; a note is
`- (YYYY-MM-DD) [note] <fact>`. Facts are single self-contained sentences.
Notebook files are ordinary versioned Company File objects: every write and
forget goes through the mutation gateway with the exact expected version
(5.2), history stays in the revision ledger, and no separate memory store or
ledger exists.

Tools: `update_memory` with `action` `write` (`fact`, optional `tier`) or
`forget` (`fact` = the exact recorded text), and `recall_memory` (`query`,
optional `limit` 1–50). Writes deduplicate; a correction is forget then write.
Recall ranks by shared distinctive words and falls back to a case-insensitive
substring match; results carry each fact's date and tier and are untrusted
data.

Composition (9.1): every turn composes the whole profile and a bounded
newest-first slice of the current and previous month's log with faded notes
removed, plus a count of facts not shown. The
block records the exact object versions it read. Composition uses the trusted
read lane, so it runs before the first acknowledgement and spends no
model-read budget; an unreadable notebook degrades to an unavailable block and
never blocks the run.

Export and import: a portable notebook is `profile.md` plus the `log/` files
with `[note]` and `[episode]` lines removed. A Grok Bot import maps the bot's
agent memory onto `agents/<staffAgentId>/memory/` unchanged; a Grok Bot export
carries no user memory, and the import creates none.

The constitution tells agents what is worth remembering and not to bloat a
profile. Code enforces the own-notebook path, concurrency, retention,
versioning, and deletion.

### 15.2 Skills

The turn receives a skill catalog, not every skill body. A skill description
states when to use it. The body is loaded on demand and its version is recorded
in the run.

Platform-owned skills are read-only runtime-bundle assets. Company and agent
skills are Company File playbooks with explicit paths, owners, permissions,
and mutation rules. A skill is not a place to hide member credentials, private
channel names, or runtime authority.

Plugins, connectors, and skills are separate:

- a skill is model-readable procedure;
- a connector is authenticated service RPC;
- a plugin is an installed capability bundle with declared permissions.

## 16. Connectors, interactions, routines, and listeners

### 16.1 Escalation path

The constitution expresses this default judgment order:

1. composed memory and Company File;
2. authenticated connector;
3. public web;
4. office browser;
5. office desktop;
6. a typed request to the relevant member.

The kernel makes each step real through tool availability, grants, and typed
handoffs. A broken connector is reported or repaired; it does not silently
authorize browser session use.

### 16.2 Interaction surfaces

Qorpera MUST use distinct state machines for:

- destructive or external-action approval;
- connector authorization;
- office sign-in handoff;
- plugin installation;
- routine consent or away-work notice;
- safety-check review or retry;
- chat choice widget;
- hiring or membership changes; and
- explicit member upload or download and cloud-realm file transfer.

Dismissal is recorded and delivered to the agent as a skip or decline,
according to the surface contract. It is never consent. Absence of a response
cannot be promoted to approval.

A gated decision waits durably in the control plane until an authorized
member is online to decide it; agents continue other work around the blocked
effect. Until a phone or web approvals surface exists, the desktop client is
the approvals window.

### 16.3 Routines and listeners

A routine stores intent plus exactly one trigger type:

- schedule; or
- listener/event.

A listener MUST NOT also be a cron. This is a scheduler invariant.

The scheduler stores an IANA timezone, computes canonical instants in UTC,
uses deterministic occurrence keys, and wakes the same agent with the routine
intent only for that occurrence. User-facing times render in the viewer's
timezone.

Quiet windows, weekday defaults, expiry, and repeated-authentication-failure
pause MUST be enforced in scheduler code if the product promises them. They
cannot remain advisory prose. Finite watches expire. A repeated authorization
failure pauses the routine and notifies an authorized member through one
durable event.

Listeners implement vendor-specific authentication and eligibility rules, such
as channel membership, webhook verification, and identity gating. Secrets
remain outside model context.

2026-09-22 amendment: kickoff occurrence. The first version of a scheduled
routine runs once at its effective instant (the kickoff) and then on its
cadence, unless the trigger names a later start or a window bounds its run
times. A later version keeps the cadence its routine already had. The kickoff
occurrence key is derived from the effective instant so every orchestrator
admits the same occurrence. Agents are told to start a new responsibility on a
dense cadence and loosen it under the same routine key once the work is
understood.

2026-09-25 amendment: expiry and edits close future scheduling only. A finite
watch's last permitted occurrence expires the routine when it is queued, and
that occurrence still starts and completes; so does an occurrence queued
before a time expiry, including one that quiet hours, a company pause or
missing capacity hold past the end (it is not dropped). This holds only for a
routine that was running normally when it ended: one that was paused (by its
agent, a member, the authorization-failure suspension or its agent's
archiving) runs nothing more, and archiving an agent also stops its ended
routines, so a restore does not revive them. A removal stops pending work
too. A new version applies to the next run: a run that has started keeps the
version it started with while its job is live (a routine run may save its own
routine), while a queued occurrence of an older version, and work that
continues after the job ended, follow the current version.

## 17. Model and reasoning policy

An attended agent thread defaults to low reasoning effort. The resolved
provider, model, and effort are pinned on every run and shown in provenance.

Routines, workers, or explicit assignments MAY select a different effort
through versioned policy. Changing provider, model, sponsor, or effort MUST NOT
silently rewrite the agent's durable defaults or an already admitted run.

2026-09-22 amendment: routine effort. The agent that sets a routine up chooses
the effort of its runs (low, medium or high; medium when it says nothing), and
the routine version stores it. The bundle's model policy declares
`overrides: routine` with the allowed set; the kernel resolves a routine wake's
effort from its routine version when the run is created and pins it as before.
Attended threads keep the bundle default.

2026-09-24 amendment: thread model and effort. A member picks the model
(GPT-6 Astra, Sol or Luna) and the effort (low, medium or high) for one
conversation in its Model menu; the choice is stored per conversation, not in
the agent document. A member's turn in that conversation (a session turn or a
room delivery) runs with it: the model applies to native subscription sponsors,
the effort to every sponsor. The bundle's model policy declares
`overrides: routine-and-thread`; bundles that declare `routine` keep thread
turns at the default. Routines, coworker wakes and other conversations are not
affected. Superseded: "Attended threads keep the bundle default" above.

2026-09-22 amendment: no turn caps. A turn is not capped by a number of tool
calls, effectful operations, transcript events or wall-clock time. The agent
works until the task is done or genuinely blocked. The remaining bounds are
safety limits far outside any real turn: the run deadline (24 hours), the job
lease that a live runner renews, the transcript byte bound and protocol flood
bounds in the native boundary. The prompt no longer advertises a call budget.
(Superseded by the second 2026-09-24 amendment in 7.4, bundle v92: there is no
run deadline and no protocol flood bound; see that list of what remains.)

Company-formation and other research projects MAY dispatch higher-effort
workers under a bounded, attributed project policy while the attended
Co-Founder conversation remains on its resolved low-effort default. The
Co-Founder's direction and responsibility-map work MAY run at higher effort
through the effort policy of the responsibilities it holds (14.2).

Provider-native continuity is an optimization. Canonical Qorpera transcript,
memory, and run state remain the recovery source across provider or sponsor
changes.

A member MAY connect several provider subscriptions at once, and a provider
connection MAY sponsor several concurrent runs under its concurrency policy;
quota, not exclusivity, is the ceiling. When a connection reaches its usage
limit the member MUST be notified. The control plane MAY then switch an
affected run to another eligible connection of the same principal, or to a
company account the routing policy permits, and continue the task. The switch
is a recorded sponsor handoff on the same run — a new binding version with
the control plane as actor, the routing policy as reason, a timestamp, and a
member notification — with context rebuilt from the canonical transcript. It
is never another member's credential and never silent. Adapters MUST
distinguish quota exhaustion (switch) from transient rate limiting (retry)
and provider outage (wait or fail over). Agents MAY later configure model and
sponsor routing for routines, workers, and teammate questions through
versioned policy objects.

## 18. Short constitution

The cached constitution is written after the kernel behavior it describes has
passed its tests. It SHOULD stay short enough to be followed in one pass and
cover:

1. what Qorpera and the agent are;
2. the law that the company is one live Company File and useful work changes
   it or creates a durable proposal;
3. mouth and turn behavior;
4. wake-specific silence;
5. identity, audience, and voice;
6. computer and escalation judgment;
7. dispatcher behavior and autonomy;
8. team, room, memory, skill, and routine judgment;
9. trust, secret, and safety laws; and
10. edge behavior such as dismissed interactions and event polling.

It MUST NOT contain tool-by-tool implementation trivia, full memory, full
skills, static teammate lists, credentials, or another copy of the hire
overlay. Provider adapters compile this constitution into their supported
native instruction surface.

## 19. Implementation order

Implement in this order or failures in an upper layer will conceal failures in
the kernel.

Order 0 is Qorpera's product-specific substrate beneath the Grok-derived brain
sequence. It exists because the tenant is a multiplayer company and the live
Company File, rather than chat or a machine disk, is what that brain operates.

| Order | Build | Required proof before proceeding |
| --- | --- | --- |
| 0 | Live Company File, path authority, and provenance | With all clients offline, one cloud company remains readable and mutable through atomic versioned path operations. Two members and one agent obey exact/private/subtree ACLs; protected paths propose; revocation and stale versions fence effects; receipts retain exact actor/requester/sponsor/approver attribution. |
| 1 | Loop plus mouth | Model input and cloud tools work over an exact Company File read view; only send is visible; provider thinking and final assistant text never render; completion links a live operation, proposal, or explicit no-change result. |
| 2 | Inbound fences, outbound effect check, and cloud secret custody | A fake instruction inside a tool or Company File result is ignored; an unauthorized, stale, protected, or ambiguous write is blocked independently; and a canary credential survives capture, use, rotation, revocation, response reflection, restart, and encrypted recovery without entering any model-visible or company-visible surface. |
| 3 | Wake bus | One agent enters through all five wake kinds; each applies its silence rule; a routine finishes with no send; an authorized Company File event wakes once, and an agent's own write never wakes itself (amended v95: no multi-agent cycle fence). |
| 4 | Shared office VM | Persistent cloud workbench, live Company File mount, shell, browser with sticky granted sessions, one company machine (additional machines are later capacity work), and several agent desktops work with every member device offline; resetting the VM leaves company state intact. |
| 5 | Workers and todos | Parent remains interruptible; blank child receives a complete dispatch; durable completion reaches the parent; todos and accepted worker outputs become Company File state and survive restart. |
| 6 | Agent memory (amended 2026-09-22, company first 2026-09-24) | An agent's profile, monthly log, and notes are its own Company File objects in the Grok Bot layout; `update_memory` write/forget and `recall_memory` work through the versioned mutation gateway with dedupe, exact-text forget, and head-conflict retry; every turn composes the profile and the recent log slice through the trusted read lane; a worker of the same agent recalls but writes only with write access; notebooks are company-owned and there is no member memory; a Grok Bot export imports unchanged. |
| 7 | Connectors | Install, authenticate out of band, call through scoped RPC, and apply the connector-to-browser escalation path. |
| 8 | Scheduler and listeners | Company File intent plus one compiled trigger wakes the same agent; deterministic deduplication, timezone, expiry, quiet policy, auth suspension, and projection consistency pass. |
| 9 | Isolated coding VMs and PRs | Worker, repository workspace, branch, follow-up identity, publication, and completion listener retain continuity; a member's sessions share one coding machine that holds no node capacity while asleep and is removed later, its allocation released only on a proven delete (amended 2026-09-24). |
| 10 | Constitution and hire overlays | Compile a short constitution over the proven loop; add a name and job spec last, without creating a second brain. |
| Post-build (deferred) | Azure backup/overflow compute | After Orders 0–10 are built, separately approve and prove the optional capacity integration and its placement, failover, isolation, recovery, release, and usage records before enabling it for users. This is not a gate on the preceding orders or initial launch. |

Context composition, versioned schemas, typed interactions, receipts, and
observability are built alongside the first phase that needs them. They are not
deferred prose.

Order 2 owns the cloud secret-custody and non-exposure kernel through deployed
canary acceptance. Its connector is a deliberately bounded, non-production
adapter used only to prove capture, effect-time authorization, unwrap, response
fencing, recovery, rotation, and revocation. Order 7 owns production connector
installation, provider-specific adapters and operation catalogs, OAuth and API
key authorization UX, and the connector-to-browser escalation product flow.
Production connector breadth MUST NOT hold Order 2 open, and an Order 2 canary
MUST NOT be represented as a launch-ready connector.

### Minimum operational observability

The initial scope MUST answer three questions: did the request finish, where
did it fail or stall, and is there capacity to serve the next company computer?
Instrument product functionality as it is built; defer sophisticated analysis
until representative usage exists. This section defines the minimum, not a
requirement to build a separate analytics platform before the product works.

#### Required records and basic diagnostics

- Reuse canonical company, actor, agent, conversation, run/job, operation and
  resource identities. Records MUST link to the computer, node or rented
  resource when applicable, and identify the software/runtime-bundle version.
  Preserve the distinct authority identities required by section 4.2.
- Jobs, model requests and major tool operations MUST record start/end times,
  terminal status and a safe error category or reference. Jobs also retain
  admission/queue time. Retries MUST remain distinguishable from new logical
  work; incomplete, cancelled or failed work MUST NOT look like success.
- Retain token and byte counts when already supplied by the operation boundary.
  Company File reads/writes retain operation, timing, outcome and available byte
  counts; unavailable counts are unknown, not zero. Logical file bytes are not
  physical NAS traffic, and resource reservations are not measured utilization.
- Computer and screen lifecycle transitions MUST retain identity, time and
  reason: requested, ready, suspended/resumed where supported, closing, closed
  or failed. Closing a client viewer is not closing its cloud computer. Retain
  actual resource-release time separately from a shutdown request.
- Basic node monitoring MUST expose CPU and memory usage, free disk space, and
  storage/network failures, with observation freshness. Existing host monitoring
  and structured runtime records MAY provide this without a new telemetry stack.

These records MUST be available to authorized operators through a basic query
or operational view. Existing transcripts and receipts remain the evidence for
manual investigation; this scope does not require copying message bodies,
screenshots or file contents into telemetry. Secrets MUST remain out of telemetry.
Access and retention MUST be explicit. Missing records, stale observations and
uncertain lifecycle intervals MUST be visible rather than silently reported as
healthy or unused.
Optional diagnostic export failure MUST NOT block product work; it does not
relax mandatory transactional authority, mutation or allocation records.

#### Live capacity and usage

The initial operational view MUST report:

- Local node/computer inventory and allocations, distinguishing starting,
  running, stopping, suspended where supported, and failed/unavailable resources.
  Running computers with and without active jobs MUST be separately identifiable;
  allocated computers with no active job MUST NOT be counted as free capacity.
- Remaining admissible local capacity in whole standard company-computer slots,
  using the configured CPU/RAM requirements and operating headroom per eligible
  node. Aggregate spare RAM or idle CPU alone is not an admission guarantee.
  Reservations for pending starts MUST consume capacity before provisioning;
  capacity is released only after the allocation's resources are confirmed free.
- Requests waiting for capacity, provisioning failures, and each placement's
  location and reason on enabled compute sources.
  Concurrent admission MUST NOT allocate the same remaining capacity twice.
- Distinct computers, companies and human users served on each enabled compute
  source. Users belonging to a company and users actively using its computer are
  separate counts. Active-user counts MUST declare their observation window
  and activity source; membership alone is not activity, and missing activity
  observations MUST NOT be guessed. Shared computers and agents are not users.
- Deferred or unconfigured overflow MUST be shown as unavailable, not spare
  capacity. When enabled capacity is exhausted, admission follows its bounded
  queue or typed capacity-unavailable policy; it MUST NOT silently enable Azure.

Live capacity MUST derive from scheduler inventory, reservations, allocation
state and provider/node observations, not a delayed analytics warehouse. Runtime
records MUST preserve placement changes so historical usage remains attributable
to the actual compute source. Azure-specific integration and accounting are
deferred together to the post-build enablement gate below.

Basic usage accounting MUST count running computer-hours once per computer,
regardless of the number of agents or members sharing it. Screen lifetimes are
separate screen-hours; suspended time is separate from running time. Retain
screen transitions so later time-weighted average/median/maximum concurrency
reports can be derived for explicit observation windows. Those richer reports
and precise screen-idle classification are not initial launch requirements.

#### Placement in the implementation order

| Order | Minimum required alongside the functionality |
| --- | --- |
| 0 | Shared identity/version linkage, queryable records, Company File operation results and existing authority/mutation receipts; baseline monitoring for deployed nodes. |
| 1 | Job, model and major-tool timing/status/errors linked to canonical conversation delivery; retain counters already available at the boundary. |
| 2-3 | Extend the same records to enforcement outcomes, queues, wake sources and retries; do not require a new analysis subsystem. |
| 4 | Computer/screen lifecycle records, basic usage accounting, current local capacity and demand, node health, and placement visibility for enabled compute. No Azure integration is required. |
| 5-10 | Extend the same small record contract as workers, memory, connectors, routines and coding computers are introduced. |
| Post-build (deferred) | Add Azure-specific placements, rented allocation intervals, failover outcomes and usage visibility with the optional Azure backup/overflow integration, before enabling it for users. |

For an already-implemented phase, close these record gaps alongside current
work rather than rebuilding the phase or waiting for the whole runtime to finish.
This is operational data collection and visibility, not a mandate for a new
warehouse, elaborate dashboard, complete distributed-tracing framework or
higher-bandwidth hardware. Existing capacity and networking are the starting
point. Responsibility measure projections required elsewhere remain mandatory;
they are distinct from optional platform-wide optimization analytics.

#### Explicitly deferred

The initial scope does not require function/line execution tracing, profiling
or production coverage; precise idle/wasted-capacity attribution; physical I/O,
cache or write-amplification analysis; automatic negative-feedback classification;
responsibility productivity scoring or staffing optimization; comprehensive
conversation analytics or historical dashboards; or autonomous diagnostic teams
and automatic optimization experiments. These MAY be added when measured
problems or sufficient usage justify them. This deferral does not weaken the
runtime's existing testing, authority, provenance or outcome requirements.

The Orders 0/2 source implementation, operator interfaces and measurement limits
are recorded in [operational observability](deploy/first-node/RUNTIME-STEPS-0-2-OBSERVABILITY.md).

### Deferred post-build integration: Azure backup/overflow

Ratified on 2026-08-31: Azure backup/overflow compute is optional rented
execution capacity for demand or compute failover beyond Qorpera's primary
cloud nodes. Its remaining provider integration, provisioning, capacity routing,
failover/recovery wiring, and Azure-specific operational views belong after
the Orders 0–10 runtime build. They MUST NOT hold Order 0/2 closure, progression
to Order 3, Order 4 completion, development-partner testing, or initial runtime
launch open.

Before this optional path is later enabled for users, its own acceptance MUST
prove the existing tenant, authority, secret-custody, isolation, and Company
File guarantees, plus:

- placement reasons and local/Azure placement history, including failed or
  unavailable overflow and failover without duplicate effects;
- computer lifecycle and confirmed resource release, with running time separate
  from retained allocation intervals and rented compute-hours; neither is an
  invoice or proof that stopping a VM removes every provider charge; and
- distinct computers, companies, associated members, and observed active users,
  with explicit activity windows and sources rather than inferred user counts.

Until that separately approved integration is accepted, Azure backup/overflow
remains unavailable. Existing code, resources, and proof records are preserved
without being treated as enabled capacity or current acceptance.

This deferral covers optional compute capacity, not Company File durability,
encrypted data backups, independent secret custody, or recovery and authority
checks required by enabled services. Those requirements remain provider-neutral
and mandatory even when an existing service happens to be hosted in Azure;
this contract does not require Azure specifically to satisfy them. A paused
required service MUST NOT be reported as production-ready.

### Responsibility model placement

The Co-Founder and responsibility model is not a new wake kind or one
isolated implementation step. Its dependencies land in the existing order:

- Order 0 owns responsibility, project, measure, membership, and
  resource-scope schemas plus their Company File projections and ACLs. These
  schemas are versioned and expected to be revised after the first real
  responsibility loops run.
- Order 3 owns Co-Founder routing, project-room fan-out, responsibility
  escalation, signal coalescing, and event-loop fencing.
- Order 5 owns responsive company-formation research, project teams, workers,
  durable plans, todos, and completion reporting.
- Order 6 owns rebuildable responsibility views and measure retrieval
  projections over Company File state.
- Order 7 owns out-of-band connection and digestion of existing company work.
- Order 8 owns responsibility cadences, scheduled measurement, listeners, and
  exception wakes.
- Order 10 owns thin Co-Founder and employee behavioral overlays after the
  operating machinery is proven.

Order 2 fences the inputs and effects used by this model; it does not own or
delay the model itself. Product UX MAY be developed against the ratified
semantic projection before every later behavior is implemented, but it MUST
NOT represent missing cloud machinery as working autonomy.

### 2026-09-01 amendment placement

- Order 1 owns the typed usage-limit signal from provider adapters and the
  member notification (section 17).
- Order 3 owns automatic sponsor handoff — the recorded continuation of an
  affected run on the next eligible connection (section 17, acceptance 29).
- Order 4 owns presence over the live Company File mount (5.2, 9.1),
  extending the lossy, membership-authorized presence channel already defined
  in `supabase/SESSIONS.md` to agents.
- Order 1 owns spend and token ceilings at run admission for sponsors
  without a provider-side usage wall; Order 3 owns the wake-rate ceiling and
  the founder stop; Order 4 owns the running-machine ceiling (7.4).
- Order 0 owns the company-level responsibility objects the Co-Founder holds
  (14.2); their loops land with Orders 3 and 8 like any responsibility.
- Additional Company Computers for one company (section 12) are capacity
  work after Order 4's one-machine acceptance.
- The failure-model chapter (section 23) is implemented during partner
  testing, after Orders 0–10 run on the primary services.

### 2026-09-16 amendment: multi-node capacity and Company Computer sizing

Ratified by the founder on 16 September 2026 after the second runtime-hosting
node came online. It refines section 12 and the Order 4 capacity records; it
does not reorder the implementation order.

- **Nodes are symmetric compute.** Every enabled runtime-hosting node is the
  same kind of engine for the traffic members bring. No node is reserved for a
  workload class; placement decides per start.
- **Placement chooses the least-loaded eligible node.** A start (Company
  Computer or member execution machine) is reserved on the enabled, healthy
  node with the most free standard slots; ties go to the node with the lowest
  allocated CPU, then memory. The placement record names the chosen node and
  the reason, and a refused start names every node's refusal. Providers are
  bound per node; the chooser selects among their nodes before the provider
  reserves. Concurrent admission MUST NOT allocate the same slot twice.
- **Runs follow the member's identity home.** A member's identity volume is
  created and initialised on the node where that member logged in and never
  lives on shared disk (12.1), so a native run is placed on the least-loaded
  eligible node among the nodes holding a login of its compute identity; a
  claimant elsewhere is refused with the home node named, and an identity with
  no home defers until a login exists. Login machines choose the least-loaded
  node and thereby open new homes. (Found on the first cross-node run, 16
  September 2026.)
- **Guest addresses are unique per node.** Several member execution machines
  and several Company Computers MUST run on one node at the same time; a
  fixed guest address in an image is a defect, not a limit (D-NATIVE-ADDR-1).
- **Standard sizes.** Company Computer: 8 vCPU, 16 GiB memory, 128 GiB root
  disk. Member execution machine (the member's own model session; holds no
  company files): 4 vCPU, 8 GiB. Node policy targets three Company Computers
  per node plus member machines within the node's operating headroom. Sizes
  are policy values and change by a new policy, never by editing a running
  allocation.
- **Screens per Company Computer.** Six desktop screens per Company Computer
  is the configured target; the actual count is measured on the live machine
  before it is promised, and an additional Company Computer for the same
  company (section 12) starts when all screens are occupied.
- **Storage.** Company Computers mount the shared NAS workbench and the live
  Company File projection directly; nothing of the company is copied per
  machine. Reads use the mount; Company File writes pass through the live
  mutation gateway (12.1). Node-local disk holds only machine roots, the
  runtime, images and journals. Usage and capacity records live in the
  backend (Order 4 records), not on nodes. Installing custom applications on
  an agent's machine is out of scope for this amendment.
- **Order.** The chooser, the address fix and the sizing policies are Order 4
  capacity work executed now on the isolated test nodes; the one-machine
  acceptance already achieved stands. Acceptance: two members' starts land on
  two nodes with recorded placements, a start with all nodes full is refused
  with reasons, and a node reboot returns its sockets and observer without
  operator work.

### 2026-09-17 amendment: identity recovery inside a member login

- **Ratification.** Follow-up to the 2026-09-16 amendment's identity-home rule
  (D-LOGIN-RECOVERY-1): a member login of an established identity on a node
  that lacks its identity volume completes without operator work.
- **Logins follow the identity home.** The login gateway chooser prefers an
  eligible gateway on a node where a login of that identity completed before
  (`IDENTITY_HOME`); only when no home node is eligible does it fall back to
  the least-loaded node (`HOME_UNAVAILABLE_LEAST_LOADED`). The edge function
  hands the chooser the digest of the login capability, never the capability.
- **Node registrars.** A runtime node's login gateway may register recovery
  targets for guests on its own node through the recovery service route
  `/v1/provider-target`, authorized by a per-node registrar capability that the
  operator enrols in the backend (`qorpera_identity_recovery_registrars`);
  the backend binds such a target to the registrar's node. The independent
  operator route `/operator/target` stays for replacement nodes; the design
  note "target registration is an operator assertion" is narrowed to targets
  on nodes without an enrolled registrar.
- **The login is the consent.** The member who began the login may recover
  their own member-owned identity for that login; a company owner may recover
  any identity of the company for a login they began. The node's gateway
  requests it on the login's behalf (`qorpera_request_login_identity_recovery`,
  service role, login-bound). The recovery of record keeps its shape: the
  company's owner of record stands as the requesting owner and the member as
  the consenting owner; activation, the quiet period, the single-use target
  and the 60-second release grant are unchanged.
- **Where the keys live.** The recipient key is generated inside the pinned
  login guest and never leaves it; the gateway mints the target capability,
  pushes it into the guest, reads back only the public key, and runs the
  shipped restore client in the guest after the quiet period. The gateway's
  own credentials do not change; the guest's bootstrap is unchanged.
- **Out of scope.** Identities without a ready backup, identities fenced by an
  unfinished recovery (refused as `LOGIN_IDENTITY_RECOVERY_PENDING` until it
  expires), and a member who is neither the identity's owner nor a company
  owner (refused; the member surface for consent is unchanged).
- **Acceptance.** On the isolated test nodes: a login of an established
  identity placed on a node whose identity volume is absent; the target
  registered by the node, the recovery requested on the login's behalf, the
  restore completed in the guest, and the login completed with the member's
  device code; evidence retained.

### 2026-09-17 amendment: host reboot as a Company Computer lifecycle event

- **Ratification.** Decided by Jonas on 16 September 2026 22:00 UTC (option B
  of D-HOST-REBOOT-2): when a runtime node is rebooted, the Company Computers
  on it close with a visible maintenance state and come back on their own once
  the host is up again, and work that was cut off is retried. This amendment
  makes that a lifecycle event of the 2026-09-16 amendment's Order 4 nodes.
- **Orderly host reboot.** A host reboot is an orderly `reboot` lifecycle
  transition of every active office on the node, opened by the node itself
  before the host goes down (a root guard ordered after the office provider and
  the LXD daemon). The transition follows the existing acknowledged-stop chain:
  screens drain, the office enters `maintenance`, the guest service stops with
  a sealed stop archive, and the VM powers off. The host reboots only after the
  power-off is recorded or the guard's window (five minutes) lapses.
- **Host boot receipt.** The office lineage is anchored to the host boot in
  which its VM chain was last observed. A resume in a different host boot is
  admitted only for a transition the guard opened as a host reboot: the
  provider verifies the stopped guest's identity against its retained journal,
  publishes a host reboot receipt (`qorpera.lxd-office-host-reboot/v1`:
  the anchoring host boot and the resumed host boot), records the resumed host
  boot in the backend, and then continues the ordinary resume, boot
  configuration and boot-successor activation. Every later physical check
  reads the resumed host boot as the lineage anchor through that receipt; the
  guest-facing boot adoption chain keeps the anchor unchanged, because a guest
  cannot observe a host boot. The office keeps its generation, workbench,
  allocation and screens.
- **Visible maintenance.** The backend records the host reboot on the
  transition (`qorpera_runtime_office_host_reboots`: requested, resumed,
  activated) and exposes it to members and providers as
  `maintenance: {reason: "host_reboot", …}` next to the office state. A member
  sees "in maintenance: host reboot" instead of a vanished computer.
- **Retry of cut-off work.** An agent that needs the office while it is in
  `maintenance` parks a start intent exactly as during provisioning; the
  waiter survives maintenance and the activation wake re-runs the agent with
  its full context when the successor activation is active. Runs whose machine
  died with the host lose their lease and are re-claimed by the next dispatch
  (the ordinary attempt budget); a node without observations for 60 seconds is
  not a placement candidate, so new work goes elsewhere meanwhile.
- **Out of scope.** An unplanned host loss (power cut, kernel crash) leaves no
  stop archive; that office generation still ends with retire and
  re-provision (D-HOST-REBOOT-4, §23 material). A second host reboot before
  the resume has completed is refused and held for the operator.
- **Acceptance.** On the isolated test nodes: a live host reboot of a node
  with an active office; the office reported in maintenance with reason
  `host_reboot` while the host is down; the same guest resumed with a host
  reboot receipt and a boot-successor activation; a screen lease refused during
  maintenance and granted afterwards; evidence retained.

### 2026-09-17 amendment: the company browser and the Company Computer as a given

The company comes first. Agents are the primary workers against it; members
review and steer through the agents. Three consequences replace the earlier
member-centred browser model of section 12.

1. **The Company Computer is a given for every agent.** Each active agent of a
   company has desktop and shell access to the company's computers by default.
   Access is not a setting a member has to find. The grant rows and their
   versions remain, because runs and leases bind to them.
2. **A member opens an agent's computer.** "Opening an agent's screen" is a
   member operation: it opens the agent's screen when it has none, and the
   office starts the desktop when the first viewer connects. A desktop start
   belongs to the office, never to the viewer that happened to ask first.
3. **One company browser.** A company has one set of website sign-ins. Every
   agent has a company-owned browser profile from the start; no member owns,
   prepares, lends or revokes a browser profile, and there is no private member
   browser on the Company Computer. Because a browser locks its profile to one
   running process and each agent works on its own desktop, agents keep separate
   profile directories and the office service keeps their sign-ins in step: a
   sign-in or sign-out in one agent's browser reaches the company's store and
   the other open browsers, and a browser that opens later starts signed in.
   Session cookies are kept, so a sign-in survives a browser or service restart.
   The store lives beside the profiles on the company workbench with the same
   protection and never enters a browser namespace, log, transcript or viewer.
   A site that binds a session to one browser, or rotates its token on every
   use, can still sign other agents out; that is the site's rule.

Signing in stays a typed handoff on the office desktop: a reviewer takes
control of the agent's screen and types; the model never receives the
password. A connector still precedes the browser wherever one exists. A
person's own accounts do not belong on the Company Computer; an agent acts for
a person only through a connection that person grants to the company.

The member-owned profile, per-agent browser consent and office-wide private
sign-in machinery of the earlier text has no client and is scheduled for
removal; until it is removed it MUST NOT be reachable from any member client.

### 2026-09-17 amendment: kept company state and credential rotation

- **Company root.** A Company Computer generation MAY carry a fifth admitted
  root, `company/`, for company-owned kept state (layout version 2). The next
  generation carries it through the adoption input's `shared.company` exactly
  as it carries the workbench and the desktop home. The company browser's
  shared sign-ins live there; they are service-only and never mounted into a
  desktop, shell or browser surface. A generation built without it keeps its
  exact version 1 layout and receipt.
- **Boot plan continuity.** A later boot MAY take a boot plan whose digest
  differs from the predecessor boot's only through a root-owned revision
  chain beside the plan, each step changing nothing but the credentials it
  names. Any other difference is refused.
- **Certificate rotation.** The office TLS credential is the node's tailnet
  certificate. Replacing it is a lifecycle operation, not a rebuild:
  `power_off` → plan revision → resume, run by a root timer that first renews
  the node's certificate. The office is offline only while a rotation happens.

### 2026-09-17 amendment: agent threads are shared channels bound by rooms

- **One thread per agent.** Every active agent has exactly one conversation
  with the company's members: a shared session with company audience that
  every member sees identically, each message attributed to the member who
  wrote it and every reply spoken by the agent. It is the closest thing to a
  multiplayer channel the provider terms allow.
- **Rooms bind it; they are not a surface.** The kernel binds each agent
  thread to a room whose members are all active company members and that one
  agent (`bound_staff_agent_id`). Rooms remain the backend binding of who may
  post and whom a post wakes; clients present agents and threads, never rooms.
  Membership follows company membership automatically; archiving the agent
  archives the thread.
- **Private runtime rooms.** A member's post runs the agent on that member's
  own model account (sponsor binding), through that member's own execution
  binding. Provider-side context windows are per member and never pooled; the
  shared thread and the Company File are the agent's continuity across
  members. A post into an agent thread requires a reply (initial optional,
  final required); team rooms keep their optional policy.
- **No member-private conversations.** Member-private sessions and the
  member-private Co-Founder conversation are withdrawn. Members MAY hold
  member-private facts in the Company File; an agent uses them only to think
  and MUST NOT repeat them into a shared thread. §14.2's separate one-to-one
  Co-Founder conversation no longer exists: the Co-Founder's thread is shared.
- **Images.** An agent thread accepts the same attachments as an agent
  session did; team rooms stay text-only.
- **The thread outlives edits of its agent (added 2026-09-19).** A wake or
  room delivery is admitted at the agent's current version and MAY use a
  session that records an earlier version of the same agent. This holds for
  every session bound to an agent, not only its thread. A session that records
  a version later than the run's is refused, and a member turn keeps its exact
  version.
- **An edit applies from the next run (added 2026-09-20).** Clients save agent
  edits at once, and every save raises the agent's version. An edit MUST NOT
  end a run. A run stays valid while its agent is active and the agent's
  version is the run's version or a later one: it keeps its wake authority,
  its Company File write authority and its Company Computer, and its job
  specification stays the charter recorded for its own version. A wake that
  waited in the queue through an edit is the agent's next run and is admitted
  at the current version; a run never claims a version its agent has not
  reached. Archiving or deleting an agent is not an edit and still ends its
  runs.

### 2026-09-18 amendment: who runs an agent's first run

§14.1's "exactly one first-run wake" is a cloud obligation, not a client
habit. The silent kickoff is seeded in the agent's shared thread, and the
greeting appears there.

- **Whose account.** Creating an agent is the creating member's own action, so
  the first run is sponsored by that member's own model account: the account
  they last used for a run in this company, or their only usable account when
  they have never run anything. No other member's account is ever chosen.
- **No usable account.** The kickoff stays pending. Its author starts it later
  with an account of their choice (`qorpera_start_agent_first_run`); nobody
  else can. This is the normal case for a brand-new company, whose founder
  connects an account after the Co-Founder exists.
- **Limits.** The founder stop holds the queued first run until resume. A first
  run is a member-caused turn and does not count against the wake-rate ceiling.

### 2026-09-19/20 amendment: agents set themselves up, hire and convene without approval

Founder decisions, 2026-09-19 and 2026-09-20.

1. **An agent's routine needs no member approval.** Part of what makes an
   agent useful is that it sets itself up to meet its responsibilities. An
   agent creates, changes, pauses and removes its own routines through its run
   authority. The routine wakes that same agent; the model chooses what, when
   and for how long, never another agent, a requester, a model account or a
   computer.
2. **Unattended use of a connected model account is not a setting.** The
   consent and sponsor records of section 11.5 and Order 3 stay, because runs,
   leases and custody bind to them, but they are granted by default when an
   account is bound and when standing work needs them. A member who does not
   want an account used disconnects it.
3. **Hiring a coworker and opening a group chat need no member approval.** Any
   active agent may create a new agent (14.1) or a new room (14.7). The
   governed write, its receipt, the projection and the rule that a creator
   cannot delegate authority it lacks are unchanged; the approval of a NEW
   agent or room is given by policy in the name of the requesting member, or of
   the company owner, and is bounded per run. A change to an existing agent or
   room stays proposed by the Co-Founder (14.2) and approved by a member.
4. **The gate is authority, never the client.** A capability a signed-in member
   has through one client is a cloud operation. Whether an agent may perform it
   is decided by the authority chain of its run, not by which surface first
   exposed it.
5. **An agent's description is its responsibilities.** The job description is
   written as the agent's responsibilities in plain prose and is the reference
   the agent orients itself by, on its first run and afterwards, creating the
   routines that keep each responsibility alive. The 2026-09-20 amendment
   below states how this replaces the structured responsibility objects of 14.3.

[Step 8 record](deploy/first-node/RUNTIME-STEP-8-SCHEDULER.md) states what is
built and what keeps Order 8 open.

### 2026-09-20 amendment: responsibilities are the agent's description

Founder decision, 2026-09-20. It replaces the responsibility model of 14.3 and
the responsibility area of 14.5, and revises 14.2 and the Order 6 and Order 8
placements that depended on them.

1. **One place.** What an agent is responsible for is its description: plain
   prose in the agent document's hire overlay, edited where the agent is
   shown and labelled "Responsibilities". It is the reference the agent works
   from. There is no separate responsibility object to author, no
   responsibility page, no responsibility map view and no measure page. A
   client MUST NOT present them.
2. **The agent keeps its responsibilities alive.** On its first run and on
   later wakes an agent orients itself by its description, reads the sources it
   names, and creates, revises and removes the routines that make each
   responsibility happen without being asked (2026-09-19/20 amendment, items 1
   and 2). A cadence is a routine the agent owns, not a field on a
   responsibility. An agent whose description names no responsibility asks the
   one question that settles its role and invents nothing.
3. **The company-level view is derived, not authored.** The Co-Founder's
   standing guarantee that everything the company cares about has an owner
   (14.2) is met by reading the agents' descriptions and the company's
   direction, hiring an owner where there is none, and proposing a change to an
   existing agent's description where responsibilities overlap or have gone
   stale. It is not a set of responsibility documents.
4. **Accountability stays singular and checkable in prose.** A responsibility
   SHOULD name its outcome, the sources that show whether it is met, and when
   the agent speaks up and to whom. Two agents SHOULD NOT be written as owners
   of the same outcome. These are authoring rules for descriptions, enforced by
   the Co-Founder's review, not by a schema.
5. **What is withdrawn.** The per-responsibility measure definitions, targets,
   guardrails, attention cadence field, responsibility-scoped authority and
   archetypes of 14.3; the rebuildable responsibility view and the wall of 14.3;
   the responsibility area of 14.5; Order 6's responsibility views and measure
   retrieval projections; and Order 8's responsibility cadences and scheduled
   measurement. Order 8's routines, listeners and exception wakes remain, owned
   by agents.
6. **The cloud objects are removed.** The responsibility tables and the
   escalation queue are dropped; no company held responsibility data worth
   keeping. Responsibility documents are no longer
   organization documents: existing `organization/responsibilities/*.json`
   files stay in the Company File as ordinary files, and a new company is born
   without them and without that folder. Agents no longer have
   `escalate_responsibility`; an agent speaks up to whoever gave it the work, or
   to the Co-Founder, through its ordinary messages. A path resource that was
   scoped to a responsibility is closed to everyone but owners and admins and
   is never widened. A project keeps a recorded sponsor as history only, and a
   member reaches a project-scoped resource as owner or admin. The agent
   document keeps its `grants.responsibilities` key, ignored, so no stored
   document becomes invalid, and the organization read model still answers an
   empty `responsibilities` list so every client keeps parsing.
7. **Tools are the intended replacement for live measurement.** The part of
   the old model worth keeping is that people can see how the things they care
   about are going. The planned form is a second kind of item beside agents:
   **tools**, internal apps and dashboards hosted in the Company File, possibly
   live, which an agent builds and keeps current with its routines. A tool
   would be ordinary Company File objects (a manifest, a page, data files)
   rendered by the client in an isolated frame with the viewer's own authority.
   This is a direction, not a commitment: it needs its own design, its own
   trust model for agent-authored interfaces, and its own contract revision
   before any of it is built, and nothing in this amendment creates it.

Implemented with this amendment: the web client's responsibility pages, routes,
map and links are removed and the agent's description field is labelled
"Responsibilities"; the employee overlay already orients an agent by its
description (Step 8 record). The cloud retirement is migration
`20260920070000_runtime_retire_responsibility_objects.sql`, with the object
gateway that stops building the responsibilities folder. Either may be rolled
out first: the database accepts both genesis trees, and the gateway waits for a
database that still mints documents.

### 2026-09-22 amendment: shared execution service

Refines section 12 and supersedes the per-run machine clauses of the
2026-09-16 amendment. Member runs execute in **sandboxes** started by a
long-lived **execution host** on an enabled node, not in a virtual machine
booted per run. A sandbox is one run's pair of one-run service units (the
member's native provider host and the single-lane runner) on a numbered slot
with its own accounts, loopback ports, tmpfs credentials and scratch
directories; the official provider harness still runs as one process per
member per run inside its existing containment. The sandbox is the running
unit for the section 7.4 company ceiling, reserved and released through the
same admission functions as before. "Member execution machine 4 vCPU / 8 GiB"
becomes a per-sandbox resource cap set by policy; the execution host itself
is the node machine.

A node's execution host is a fixture created by the operator from the pinned
runner guest image, replaced, never relabelled, on bundle activation. It pins
one runtime bundle and refuses runs pinned to another. A run whose sandbox
fails is that attempt's failure under the existing retry path; queued jobs are
served by the restarted host. The control plane remains the only dispatcher;
its orchestrator polls at 250 ms.

Login custody is unchanged by this amendment: a member's Compute Identity
volume is attached to the execution host of its home node, the capsule master
key is handed to one run's native host as a credential, and the credential
capsule is opened only inside that host's private scratch root. With one
execution host per node the identity-home rule of 2026-09-16 continues to
hold; moving login custody into the cloud secret broker (which would make
nodes symmetric for any member) is a separate, later amendment.

Proposal review keeps its copy-isolated one-run guest. Company Computers
remain shared virtual machines under section 12.

### Current implementation checkpoint

The NAS-backed live Company File and native cloud runner path already exist.
The signed v44 infrastructure proof includes a real attended cloud turn writing
the shared NAS mount. The standalone orchestrator and LXD provider were running
during that historical audit. Subsequent approved drains and mount retirement
are recorded in the production acceptance record; this paragraph does not
assert their present operating state or authorize the legacy raw-mount lane.

The phase-zero path kernel now has source implementation for company, member,
and agent principals; exact and subtree scopes; private ownership;
target-bound grants; action provenance; effect-time revalidation; protected
proposals; and the governed immutable path-mutation gateway. The organization
extension adds one enforced company Co-Founder, resumable formation state,
responsibilities and their measures, projects, staff assignments,
responsibility- and project-scoped resources, canonical agent documents,
bounded grant delegation, governed agent lifecycle, per-member private
Co-Founder sessions, and exact Company File version bindings. Initial Company
File creation seeds the canonical organization directories, a reference-only
formation document, and the canonical Co-Founder agent document, then binds
one silent kickoff to that exact agent path version. Recovering an already
governed company advances at most one missing path per durable snapshot and
preserves evolved canonical bytes. Service cutover projects every supplied
organization document from its exact UTF-8 bytes in the same transaction and
rejects missing, extra, stale, or projection-blind state. Responsibility,
project, and room grant references do not create membership; the corresponding
canonical organization object remains the membership authority.

The Order 0 source, disposable-database proofs, and replacement-client
hierarchy reconstruction are therefore implemented. The hierarchy is rebuilt
from closed cloud projections and keeps Co-Founder, responsibility, project,
room, active staff, and inactive organization semantics distinct; local
recency is not authority. Production migration/cutover and live offline
multi-member acceptance remain deployment gates. File-change wake delivery,
room fan-out, formation workers, dashboards, connectors, routines, and
behavioral overlays remain in their ratified later orders; they must not be
confused with an absent live NAS mount or moved into a desktop-owned runtime.
See [Runtime Step 0 organization
implementation](deploy/first-node/RUNTIME-STEP-0-ORGANIZATION.md) for the
exact source boundary and proof status.

Runtime step 6 (amended 2026-09-22) now has an implemented agent notebook in
the Grok Bot shape: `update_memory` and `recall_memory` over the agent's own
profile, monthly log, and notes as versioned Company File objects, a composed
memory block through the trusted read lane, and the observation vocabulary for
both tools. Notebooks are company-owned Company File objects and there is no
per-member memory (company first, 2026-09-24). Grok Bot import and an
owner-only write rule are deferred; nothing is applied live. See
[Runtime Step 6 memory](deploy/first-node/RUNTIME-STEP-6-MEMORY.md).

Runtime step 1 now has an implemented cloud-native mouth: a run-bound MCP send
tool, atomic canonical transcript writes, durable idempotency receipts, and
required final delivery for conversation turns. Provider assistant text,
reasoning, and diagnostics are private; the native result is a closed v2
completion receipt, not an assistant message. Jobs without a conversation can
finish silently; the five-kind wake policy is still step 3.

The historical Step 1 mouth passed real connected-OpenAI cloud acceptance and
the published client's cancellation/replay checks. That proof remains valid
for its recorded bytes. It does not accept the later organization, governed
path, secret-custody, or executable-provenance assembly: that assembly needs
its coordinated migrations, compatible signed image, and live acceptance.
See [Runtime step 1 audit and rollout](deploy/first-node/RUNTIME-STEP-1.md) for
the exact evidence, limitations, and deployment sequence. Neither this
checkpoint nor the earlier infrastructure proof closes the full launch gate.

The Steps 0–2 review corrections add a generated executable bundle, immutable
resolved low-effort policy, exact launch catalog/context digests, and durable
Company File read/provider-view provenance in migrations `19700`–`19900`.
Forward corrections `18200` and `19850` close missing-member authorization,
capture/grant revival and admission races, recreated-wrapper privileges,
membership/history coupling, and private-to-shared publication boundaries.
The broker's exact three-function surface is checked after the combined chain,
not just after its own migrations.
These are source and disposable-test results, not a new signed or deployed
acceptance claim. Historical symbolic bundles and unknown effort remain
historical; no Step 3 behavior is incorporated. See
[Steps 0–2 review corrections](deploy/first-node/RUNTIME-STEPS-0-2-REVIEW-CORRECTIONS.md)
for the verification and current integration gates.

Runtime step 2 now has an implemented company-centered secret-custody and
non-exposure component: immutable encrypted versions, company/member ownership,
per-agent operation grants, exact effect-time broker authorization, one-time
out-of-band capture, compiled destination-bound adapters, and response
reflection fencing. Governed cloud execution has no local or plaintext secret
fallback. An isolated Azure/Supabase canary has proved capture, use, restart,
encrypted recovery, rotation, revocation, reflection fencing, and post-run
non-exposure. The broker now authenticates through a dedicated PostgreSQL login
with no direct table access, elevated attributes, `service_role` membership, or
functions beyond three fixed custody calls; a deployed live run re-proved safe
use, all four reflection encodings, effect-time revocation, and receipt
reconciliation. A disposable unsigned v53 guest also passed the clean-boot
negative boundary: KVM Secure Boot, empty bootstrap and company mounts,
inactive runner/model services, no Azure workload identity, and no broker
operation without host-issued authority. That is not signed provenance and did
not invoke a model. These are historical component checkpoints, not acceptance
of subsequently changed runtime bytes. Later signed custody proofs and cleanup
are recorded separately; the latest
[Steps 0/2 closeout](deploy/first-node/RUNTIME-STEPS-0-2-CLOSEOUT.md) identifies
the exact remaining candidate and deployment gates. Production connector
adapters and member-facing connector authorization flows remain Order 7. See
[Runtime step 2 company-centered cloud secret custody](deploy/first-node/RUNTIME-STEP-2-SECRET-CUSTODY.md)
for the exact completed component evidence and remaining deployment gates.

The minimum Orders 0/2 operational-observability source is implemented:
canonical operator queries, native logical-turn and major-tool records,
enforcement outcomes, human Company File request diagnostics and baseline node
measurements. Optional collection cannot authorize or retry work. Retention,
missing records, stale samples and unavailable measurements remain explicit;
no content or secrets are copied into telemetry. The closeout records its
verified bundle and coordinated deployment requirements. Computer/screen
lifecycles, capacity, placement and usage extend this boundary in Order 4;
optional Azure overflow remains deferred as ratified above.

Runtime step 3 (Order 3) now has a source implementation on the runtime
line: the durable typed wake bus with five admitted kinds and their reply and
silence policy enforced at send admission, at every governed operation and
model-requested read, and at completion; authorized Company File event wakes
with causal fencing; durable coworker delivery; rooms as canonical
organization objects with group conversations and member-post fan-out; the
wake-rate ceiling and the founder stop; automatic sponsor handoff on a usage
limit; member consent for autonomous work; and the default agent read grant
ratified 2026-09-02. Disposable-database acceptance passes nineteen cases.
Deployed acceptance with clients closed on the production node remains the
gate before Order 3 is closed. See
[Runtime Step 3 wake bus](deploy/first-node/RUNTIME-STEP-3-WAKE-BUS.md).

Runtime step 5 (Order 5) now has a source implementation: an in-house worker
is a blank child run of the same agent admitted through the wake bus (source
kind `worker-dispatch`) with a complete dispatch, no conversation and therefore
no public mouth; its single durable report revives the parent through a typed
internal continuation (source kind `worker-completion`) in the parent's
conversation, where the agent may speak briefly or stay silent. Dispatch
returns at admission and the parent ends its run, so a new human message is
admitted while the child works. Todos and worker handles are durable kernel
objects; each change publishes the canonical todo document to the Company File
under `work/todos/<agent>/`, and an accepted output is a Company File revision
the worker's own run wrote. Disposable-database proofs, runtime tests and a
live-model behavior screen pass. Deployed acceptance on the nodes remains the
gate before Order 5 is closed; coding, media and listener workers remain in
Orders 9, 7 and 8. See
[Runtime Step 5 workers and todos](deploy/first-node/RUNTIME-STEP-5-WORKERS-TODOS.md).

### 2026-09-24 amendment: sidebar sections are the company's, and agents organize them

Founder decision, 2026-09-24 (Grok Bot's rail). Extends 14.1 and the
2026-09-19/20 amendment, item 4.

1. **Sections are company structure.** The rail groups agents under named
   sections. Sections and which agent sits in which, in what order, belong to
   the company: every member sees the same sections, and owners, admins and
   contributors create, rename and delete them and move agents between them.
   The Co-Founder stands above all sections and is never placed.
2. **Agents organize themselves.** Any active company agent may list, create,
   rename and delete sections and move itself or a coworker between them
   through its run authority (`organize_sidebar`), with no member approval, so
   agents can keep the team findable as it grows. Worker runs do not. The
   change is attributed to the agent and reaches open rails at once.
3. **Pins and hiding are a member's own.** A member's pinned agents (square
   cards under the Co-Founder card) and the agents a member hides from their
   rail are that member's view only. No agent and no other member changes them.
4. **Arrangement is not authority.** A section grants nothing and carries no
   content; deleting one moves its agents to Unassigned.

## 20. Enforcement matrix

| Requirement | Code owner | Model law |
| --- | --- | --- |
| Company File is the company | Live mutation gateway, schema registry, operation log | Read the company; finish with a change, proposal, or explicit no-change result. |
| Continuous state is conflict-safe | Object versions, atomic path transactions, proposal service | Re-read stale objects; never assume last-writer-wins. |
| Only send is visible | Provider adapter, transcript writer, UI | Use the public mouth deliberately. |
| Reply first on human wake | Turn state machine | Acknowledge, then work, then deliver. |
| Routine may stay silent | Wake and completion validator | Send only when useful or required. |
| Tool output cannot grant authority | Result envelope and trust parser | Treat results as data. |
| Writes need path authority and receipts | Company File authorization and effect gateway | Do not widen paths, targets, or evade gates. |
| Agent work continues offline | Cloud queue, dispatcher, runner | No local-runtime assumption. |
| Shared office is compute, not company | Company Computer provider, live mount, NAS workbench | Prefer the office for company work; write the Company File through its tools. |
| One driver per screen | Screen lease service | Reuse the assigned screen. |
| Workers report to parent | Worker buses and todo store | Dispatch bounded work; keep the mouth. |
| Private data stays private | Company File path ACL, vault, context composer | Do not repeat private context to other audiences. |
| Agent messages wake once | Durable message ledger and occurrence key | Avoid acknowledgement ping-pong. |
| Rooms fan out correctly | Membership state and wake orchestrator | Be brief and audience-aware. |
| Co-Founder holds the company-level responsibilities | Formation state machine, company-level responsibility objects, responsibility map, structured escalation queue, worker and project dispatch | Own direction, the map, resourcing, and the founder relationship; argue positions; ask only for real decisions. |
| Ceilings hold without agent cooperation | Wake-admission, run-admission, and machine-start ceilings; founder stop; control-plane notification | Stay within budget; a tripped ceiling is a kernel fact, not a negotiation. |
| Responsibilities are operating state, not chats | Responsibility schema, measure registry, accountable-agent assignment, ACL projections | Own the outcome and its measures; turn exceptions into verified work. |
| Responsibility views remain derived | Company File sources, measure projections, provenance, and rebuild service | Reason from exact sources and report material changes. |
| The Company File is one live document | Live mount, presence service, object versions | See who is working where; re-read on a stale version; never copy the company. |
| Sponsor routing is recorded | Routing policy, usage-limit signal, sponsor handoff | Continue on the next eligible connection; never another member's credential. |
| Projects remain bounded and distinct from rooms | Project registry, team membership, todos, outcome, and room lifecycle | Coordinate in the room; finish in durable company state. |
| Routine policy is real | Scheduler and listener services | Author sensible schedules and intent. |
| Dismissal is not consent | Interaction state machine | Treat dismissal as skip or decline. |
| Coding follow-up keeps continuity | Worker identity, VM, branch contract | Steer the existing worker. |
| Member machines are not agent tools | Capability compiler and cloud-only execution policy | Request an explicit upload when a member-held file is needed. |
| Secrets stay out of context | Company-centered cloud secret broker, operation grants, credential bridge, and result fence | Refer to purpose and handle, never value. |
| Low effort is the thread default | Run admission policy | Escalate effort only for a reason. |
| Basic diagnostics stay attributable | Runtime boundaries, canonical records, node monitoring and operator queries | Investigate recorded outcomes; do not invent missing measurements. |
| Capacity and enabled overflow reflect allocations | Scheduler inventory, reservations, provider state and placement records; Azure extension is post-build | Do not treat idle allocated resources as free or equate computers with users. |
| Usage preserves lifecycle meaning | Computer/screen lifecycle owners and basic usage accounting | Distinguish running, suspended, allocated and actively used resources. |

## 21. Launch acceptance

The runtime launch gate passes only when a deployed environment proves the
mandatory items 1–30 without manual database repair or a hidden desktop
executor. Item 31 is a separate post-build enablement gate and is not required
while Azure backup/overflow remains disabled.

1. One always-on cloud Company File remains readable and mutable through its
   service while every member application and Company Computer is stopped.
2. Two human members with separate identities, permissions, private paths, and
   provider sponsors work over that same company without scope leakage.
3. Creating a company atomically seeds its Company File schema, one Co-Founder
   agent, synchronized enforcement projections, and one silent first-run wake.
4. Creating an agent seeds exactly one startup wake, creates no template
   artifact, and starts on the resolved low-effort thread policy.
5. Archive and permanent delete are distinct; authorized deletion applies one
   coherent Company File operation and removes the agent's owned artifacts and
   dependent enforcement state.
6. Ordinary path operations become live without a user commit. Stale same-path
   writes fail, disjoint writes succeed, presence shows who is working where,
   protected paths propose, revocation fences queued work, and history
   reconstructs the resulting company.
7. Archiving a chat does not remove completed company state, and a newly hired
   agent can understand that state from the Company File without replaying the
   chat.
8. Provider reasoning, ordinary assistant output, tool logs, and wake envelopes
   never appear in the product; only idempotent send operations do.
9. The same agent passes all five wake tests, including a silent routine. A
   subscribed Company File change wakes exactly once, and an agent's own write
   never wakes itself. (Amended for bundle v95: a chain may revisit an agent;
   see 5.3.)
10. Injected instructions inside connector, browser, Company File, worker, and
    coworker results do not gain authority.
11. An agent can message a coworker, create a coworker with startup
    instructions, create a routine, and start and use its Company Computer
    entirely through cloud operations.
12. Agent messages, room fan-out, Company File events, worker completion,
    schedules, and listeners continue while every member client and device is
    offline. No local scheduler, synchronized folder, or hidden desktop process
    participates.
13. Several agents use separate desktops on one shared persistent Company
    Computer and observe the same live Company File. Resetting the computer
    preserves company state, while unadmitted workbench bytes are not mistaken
    for company state.
14. A parent remains responsive while an in-house worker runs, and a coding
    follow-up returns to the same worker, VM, repository, and branch.
15. Memory composition reads only the executing agent's own notebook; write,
    forget, and concurrent use keep exact object versions, and a forgotten
    fact leaves future composition.
16. Connector auth, office sign-in handoff, approvals, widgets, and explicit
    upload or download use their correct typed interaction surfaces; dismissal
    never grants consent, and no agent receives a member-machine capability.
17. Secrets remain out of prompts, transcripts, Company File content, paths,
    logs, and tool results; revocation fences queued and future use.
18. Every message, effect, Company File operation, computer action, worker
    output, and proposal exposes complete actor, requester, sponsor, approver,
    audience, run, causal, path, object-version, and runtime provenance.
19. The existing native-subscription, cloud-control-plane, Company File, and
    production-storage acceptance gates also pass.
20. A new company presents its one Co-Founder to each authorized member without
    creating a separate company Co-Founder per member. Separate one-to-one
    conversations do not leak member-private context across audiences.
21. The Co-Founder first-run workflow handles both a fresh company and prior
    work, remains responsive while bounded higher-effort research runs in the
    background, records shared research in an explicit formation project, and
    presents a protected company-direction proposal for founder ratification.
22. One founder direction is delegated through responsibilities and projects,
    and the founder receives one coherent result, blocker, or genuine decision
    request without needing to visit every underlying agent or room thread.
    The Co-Founder detects a material deviation between direction and
    evidence and brings the founder a recommendation.
23. An active responsibility with an accountable agent detects one source
    exception, wakes only that agent, creates or performs the appropriate work
    exactly once, verifies the outcome, updates canonical state, and escalates
    only when its declared threshold requires it. The loop survives runner and
    client restart without polling chat.
24. Responsibility, project, room, view, and agent remain distinct objects:
    closing a project room does not complete the project, completing a project
    does not retire its responsibility, and neither chat history nor a view
    projection becomes the source of company truth.
25. A replacement client reconstructs the Co-Founder, responsibility, active
    project or team-room, and individual-staff hierarchy from canonical cloud
    state; local pinning, recency, or an open desktop process is not authority.
26. An authorized operator can follow a successful, failed or cancelled request
    through linked job/model/major-tool records to its outcome, software version
    and assigned compute, without collecting function-level execution traces.
    Missing diagnostics and stale node observations are visible.
27. Computer/screen lifecycle records distinguish viewer closure, computer
    shutdown and resource release; basic computer-hours do not multiply when
    several agents or users share the computer. Missing intervals remain unknown.
28. The operational view shows local allocations, pending starts, unavailable
    resources, waiting demand and remaining admissible whole-computer capacity.
    Concurrent starts cannot consume the same slot, and a stopped or failed
    computer does not release a reservation until its resources are confirmed free.
29. When a sponsoring connection reaches its usage limit, the member is
    notified, and an affected run continues on the next eligible connection
    of the same principal (or a policy-permitted company account) through a
    recorded sponsor handoff with full provenance. No other member's
    credential is ever used, and a transient rate limit or provider outage
    does not trigger a handoff.
30. A company's ceilings hold without agent cooperation: a deliberately
    runaway loop is stopped at its wake-rate or spend ceiling, the founder
    stop operation pauses the company, and the founder is notified from the
    control plane. (Amended 2026-09-24, see 7.4: only the operator stop
    remains; since bundle v92 there is no machine limit either.)
31. **Deferred post-build enablement gate, not a launch prerequisite:** before
    Azure backup/overflow is enabled, demand beyond local capacity is attributable
    to Azure placements and rented allocation intervals. The view distinguishes
    computers, companies, associated users and observed active users, retains
    local/Azure placement history, and exposes failed or unavailable overflow.

Passing unit tests against a local provider, describing the behavior in an
instruction file, or leaving a desktop open to execute work does not pass this
gate. Section 24 defines the testing environments and evidence required to
distinguish component verification from deployed acceptance.

## 22. Launch boundary

Once this contract's mandatory launch gates and the applicable infrastructure
gates for enabled services pass, excluding deferred Azure backup/overflow,
Qorpera has the missing operating layer required for launch: one live digital
company and durable cloud coworkers that work over it with a real mouth, real wakes, real
path authority, real tools, a shared office, governed memory, routines, and
workers.

Product quality, provider policy, operational reliability, billing, support,
and security-response readiness remain separate launch responsibilities. This
contract defines the agent-runtime bar; it does not waive those gates.

## 23. Failure model

Qorpera hosts real companies, so every layer needs a stated failure model:
the control plane; the Company File mutation gateway and object store/NAS;
Company Computers and their workbench; workers; provider connections; and
network paths. For each layer the model MUST state detection, degraded
behavior, recovery, and who is notified, and it MUST preserve the
one-authority rule: two arbiters accepting work is the fork bug in permanent
form.

The seed is the primary/backup design in `supabase/SESSIONS.md`: failover is
decided by a referee, never by a client; every flip increments an epoch;
writes carry the epoch; a deposed primary demotes itself; members see the
swap as a system event where they are already looking. The chapter extends
that design so the Company File mutation gateway carries the epoch as well.
Two elements of that document are superseded when the chapter is written: its
single shared session per staff agent becomes one open conversation per agent
and audience scope (14.2, 14.7), and its temporary desktop-adapter execution
language is removed once the dispatcher is deployed.

Azure is the pinned compute provider for demand overflow and failure standby,
enabled through the post-build gate in section 19. Baseline durability of the
Company File applies to every company; deeper retention, point-in-time
restore windows, and dedicated disaster-recovery features are tiered for
paying customers.

Ratified 2026-09-01: the chapter is required, and its implementation is
deferred until the platform runs on its primary services; it is built and
proven during partner testing. Until then a paused or unimplemented
resilience path MUST be reported as unavailable, never as healthy.

## 24. Testing

### 24.1 Execution environment and scope

Runtime verification MUST use the actual Linux runtime-hosting machines as its
default execution environment, using available nodes or isolated test
allocations on them. This includes runtime unit/regression suites, packaging
checks and system integration tests. Release verification of the runtime MUST
run there; a developer workstation is not the reference runtime platform.

Quick local checks MAY supplement node execution. Web development and
frontend-only tests MAY run locally. Fixing macOS-specific test portability is
not a prerequisite for the cloud runtime release unless it exposes a defect in
the supported runtime. This chapter does not authorize desktop/macOS app
integration or advance any deferred implementation order.

If suitable node capacity or access is unavailable, report the specific missing
resource and the affected verification, and continue independent work. Local or
other Linux CI results MAY provide interim feedback, but MUST NOT be silently
substituted for required node or deployed acceptance. Availability and measured
performance, not an assumption that Linux is always faster, guide scheduling.

### 24.2 Real boundaries and component tests

Running on a node does not make a test an end-to-end test. Pure logic tests MAY
use deterministic fixtures and simulated failures there. System integration
tests MUST exercise the actual relevant components: LXD and guest lifecycle,
Linux permissions and namespaces, systemd, the configured storage backend,
database concurrency, network routing, and provider boundaries, as applicable
to the behavior under test. Use the intended deployment versions/configuration
and record material differences.

Docker or other containers MAY provide disposable databases, dependencies and
component test environments. They MUST NOT stand in for the host kernel,
hypervisor, storage or guest-service boundary whose behavior a test claims to
prove. Docker on a developer Mac is not evidence of execution on a runtime
node. Simulated systemd, storage, provider or reset results MUST be identified
as simulated; passing them does not close their real integration gates.

Final acceptance MUST exercise the installed release through its supported
public interfaces and real services. Headless acceptance MUST establish
operation without a web or desktop executor, including external package
import/call and client-independent continuation. Where web integration is in
scope, separate end-to-end acceptance MUST connect the deployed web client to
that runtime. Existing phase-specific and launch gates remain authoritative;
this chapter neither replaces them nor pulls deferred gates into earlier work.

### 24.3 Isolation and parallel execution

Available runtime-hosting machines SHOULD be used for parallel independent
test groups, with explicit ownership and bounded CPU, memory and storage use.
Reserve test capacity; do not treat idle but allocated company resources as
free. Use disposable test companies/identities, VMs, storage and workspaces
where needed. Tests MUST NOT accidentally inherit live endpoint credentials
or provider tokens. Unit/regression tests MUST use faux providers; real provider
calls belong only to explicitly scoped live integration/acceptance tests.

Absence of customer traffic permits use of available machines; it does not
remove isolation requirements. Parallel reset, deletion, recovery, migration
or deployment tests MUST NOT mutate the same allocation or shared service
state concurrently. One owner MUST serialize shared live mutations. Preserve
unrelated workloads, retained evidence and unresolved operations. Cleanup MUST
be limited to identified test-owned resources; this chapter is not blanket
authorization to erase a node or existing company data.

Tests that reboot a host or alter host-wide LXD, networking or storage services
MUST reserve the affected host/resources exclusively and account for all
dependent workloads. Separate VM names alone do not isolate host-wide effects.

### 24.4 Feedback, acceptance evidence and efficiency

Run focused affected tests while iterating, and the applicable combined suites
at integration/release checkpoints. Reuse passing evidence for unchanged code
and dependencies when its environment and assumptions still apply; changes to
shared contracts or infrastructure require the corresponding broader checks.
Do not rerun the entire repository solely because an unrelated document or
test-report description changed. Do not weaken assertions, isolation or
security checks to improve timings.

Exercise risky real-system boundaries early on isolated node allocations,
before accumulating broad fixture-only proof. Independent agents MAY own
separate test groups and reviews; agent parallelism MUST respect the same
resource and mutation ownership rules.

For each verification group, retain a concise record of source/package
identity, execution host/environment and relevant versions, command/scope,
elapsed time, result, and any simulated or untested boundary. Existing test
logs and deployment records SHOULD supply this evidence without duplicate
bespoke reporting machinery. Profile the slow groups and use bounded
parallelism or sharding where safe. Test counts alone are not a progress or
readiness measure: report separately what passed as a component test, what
passed on real node infrastructure, and which deployed acceptance gates remain.
