# Cloud control plane and runner orchestration

**Status:** Normative architecture contract. Existing desktop execution paths
are transitional and must not be used to claim autonomous cloud operation.

## Authority boundary

Supabase and object storage are the durable company control plane. They remain
available and internally consistent without an open desktop or a running agent
computer.

Supabase owns:

- company sessions, input queues, scheduled occurrences, and immutable runs;
- runner registrations, assignments, heartbeats, claims, and leases;
- team activity, membership, permissions, and review state;
- execution-sponsor and provider-connection metadata;
- operation receipts and Company File revision pins.

Object storage owns immutable Company File objects, attachments, artifacts,
review proposals, and encrypted checkpoint or machine-volume objects. Storage
paths and object names are not authority by themselves: Supabase rows identify
the retained roots and valid transitions.

The trusted `packages/object-gateway` data service implements the self-owned NAS
transport. It authenticates member requests against Supabase, hashes uploads
server-side, and confirms the catalog only after durable storage. It is part of
the cloud data layer, not the execution-computer layer.

The Company File is the cloud-authoritative data plane for the company's
durable digital body, not a desktop folder or NAS share. Its content scope,
projection semantics, repository/worktree boundary, and recovery-admission
contract are defined in `COMPANY-FILE.md`.

The control plane never assumes an Electron path, a member's local credential
store, a particular physical computer, or a writable shared NAS filesystem.

## Durable identities

### Company session

A company session is shared cloud state. Its canonical input order, transcript,
attachments, activity, revision pins, runs, and review decisions are visible to
authorized members. It is not a provider login or a process on one computer.

### Execution run

Every attended turn, scheduled occurrence, inbound event, room delivery, and
manual run has one immutable execution-run identity before work is dispatched.
A run records:

- its profile, environment, source kind, source identity, and exact input IDs;
- the pinned Company File snapshot and staff version;
- the selected sponsor binding and provider connection;
- the runner assignment and attempt history;
- the provider-native session ID when the provider supports one;
- the immutable transcript output range;
- the resulting Company File revision or review proposal;
- terminal, failed, review-pending, or ambiguous disposition.

The provider-native session ID is a resumability hint. Continuity always falls
back to reconstructing provider context from the canonical Qorpera transcript.

### Compute identity, logical computer, and physical runner

A compute identity is the durable credential and policy boundary. Its immutable
ownership is one of member, company, department, or security boundary. Member
subscription capsules are always owned by the member who completed the native
login; they cannot be relabeled as company credentials. Company-owned compute
identities may hold company-owned credentials, while department and security
boundary identities give company policy a narrower durable scope.

A logical computer is a durable machine policy identity: template,
capabilities, permissions, compute-identity reference, optional encrypted
volume, and runtime history. A physical VM or container is a disposable or
suspendable realization of that identity. Its Company File checkout,
repository worktree directory, process state, and local disk are caches. The
repository objects, refs, unmerged work, and recovery checkpoints required to
reconstruct durable company work belong to the Company File data plane.

### Execution sponsor

Every run selects exactly one versioned sponsor binding:

- a member-owned provider connection;
- a company enterprise/service account; or
- a company API-billing account.

The binding records provider account, consent, permitted attended/autonomous
modes, and lifecycle state. A handoff creates a new version with an explicit
actor and timestamp. It never silently falls back to another member's
credential.

Provider credentials live in an encrypted compute-identity capsule. The
control plane stores only its opaque reference, ownership, consent, policy,
lease, and provenance, not refresh tokens. A short-lived lease authorizes one
run and one native harness. Only the trusted computer-side credential bridge
may decrypt the capsule for the unmodified provider-native harness; Qorpera
application and control-plane code must never receive the plaintext.

Runtime Step 2 has one explicitly authorized exception to "unmodified": the
pinned Codex result-only callback and governed direct-tool selection in
[`../deploy/first-node/native-codex/README.md`](../deploy/first-node/native-codex/README.md).
It does not change native authentication or credential/transport ownership.
Direct tool selection applies only to the cloud-fenced native process; the host
requires its separate capability marker before admitting a model request.
Its source and executable hashes, fail-closed handshake and acceptance gates
are required; this exception does not authorize a model gateway to receive
personal-subscription credentials or traffic.

This is an application security boundary, not a claim of cryptographic
infrastructure-operator blindness. Until confidential, remotely attested
compute is deployed and verified, an infrastructure operator with VM
administrative access may technically inspect the runtime. Product and legal
claims must state that limitation explicitly.

## Cloud orchestration authority

Supabase is the durable orchestration authority. Database transactions and
authenticated control-plane functions materialize work, apply policy, claim
jobs, issue leases, record assignments, and reconcile durable state. Realtime
notifications are wake-up hints only. Scheduled, idempotent reconciliation of
the database is the correctness path when notifications are delayed or lost.

This authority does not execute a model and does not require a running desktop
or computer. With no execution dispatcher deployed, Supabase can still accept,
order, pin, and retain work; runnable jobs remain visibly queued.

For each runnable execution, the Supabase orchestration contract:

1. transactionally reserves the durable run and records an attempt;
2. validates the sponsor, consent, provider mode, quota, revision pins, and
   review policy;
3. records the required logical-computer capabilities and execution boundary;
4. creates a runner assignment and stores only the hash of a short-lived,
   single-job capability;
5. exposes the assignment only through its private, scoped dispatch contract;
6. records registration, heartbeat, run lease, and unresolved operation
   receipts;
7. retries infrastructure failures without changing the execution-run identity
   or duplicating a completed effect;
8. reconciles staged outputs, transcript events, and the automatic/review
   publication decision before completing the run;
9. records when a physical runner may be stopped or recycled while retaining
   the logical computer and required encrypted state.

Only Supabase's orchestration authority assigns queued work. A runner cannot
list the global queue, choose a job, or convert its registration credential
into arbitrary job authority.

## Future execution dispatcher

The future execution layer needs a continuously running dispatcher between
Supabase and Qorpera-owned runner infrastructure. Its implementation contract
lives in `packages/runner-orchestrator`. Despite the historical package name,
the service is a dispatcher and reconciliation bridge, not the canonical
scheduler or state authority. It claims and mutates work only through Supabase
transactions, provisions or selects physical runners through a provider
adapter, delivers job-scoped capabilities out of band, monitors machines, and
stops or recycles them when Supabase policy permits.

The `supabase/functions/runner-orchestrator` endpoint is the dispatcher's
authenticated control-plane interface. The Edge function does not host the
native harness and does not provision computers. Deploying that endpoint alone
therefore proves cloud orchestration, not autonomous model execution.

## Runner contract

A runner registers against one assignment capability, materializes the exact
pinned Company File and repository references, and invokes the selected native
provider harness. During the lease it may:

- append hash-chained transcript events for its run;
- reserve and complete idempotent operation receipts;
- upload immutable outputs, checkpoints, and a candidate Company File revision;
- heartbeat and renew its assignment.

It cannot mutate the canonical Company File head, select a different sponsor,
read another run, or receive a long-lived Supabase, object-store, provider, or
vault credential. Publication is an orchestrator/control-plane transition:
operational work is automatic by default, while configured review pipelines
produce a durable proposal.

## Native harness adapters

Provider execution is behind a versioned adapter interface. An adapter declares
its authentication modes, supported resumability, instruction/configuration
surface, tool protocol, event normalization, and revocation behavior.

- OpenAI Codex uses the native Codex App Server, SDK, or supported noninteractive
  CLI surface, with `AGENTS.md` and supported Codex configuration.
- Anthropic uses native Claude Code, with `CLAUDE.md`, supported settings,
  hooks, tools, and MCP.
- Other providers require equivalent native adapters or use their supported API
  mode.

Provider-specific launch enablement is a policy and compliance decision,
separate from implementation support. Disabling a provider at launch does not
remove the native personal-subscription schema or make it depend on a member's
physical device.

The generic Pi/custom-system-prompt harness remains an API-funded compatibility
adapter. It must not impersonate a native subscription client or receive an
unsupported consumer OAuth token.

## Operation and publication ordering

An operation receipt is keyed by the durable run and a logical operation key
that remains stable across model/tool retries. External effects require a
downstream idempotency key or a durable reconciliation status. An unresolved or
ambiguous receipt fences later effects in the same run and enters human
recovery; incrementing a tool-call ordinal cannot bypass it.

A Company File mutation is first staged as an immutable run-scoped delta. A
receipt that represents that mutation is not completed until the staged delta
is linked to a verified published snapshot or durable review proposal. Uploading
objects does not advance the canonical head. The head advances only through a
validated compare-and-swap transition.

## Transitional local adapter

Before managed computers are deployed, tests may use a fake or local runner
provider adapter behind the same orchestrator interface. It may start a local
process or disposable container, but it receives the same assignment capability
and pinned substrate as a future cloud runner. It does not grant Electron queue
claiming authority and is never described as autonomous all-machines-offline
execution.

## Step 1 status: cloud control plane

The branch already has useful pieces: immutable Company File objects, verified
snapshot publication, durable session inputs, turn and wake leases, runner
registration, sandboxing, job-scoped broker credentials, append-only events,
and output substrates.

The generic runner has been moved to orchestrator-issued assignments: it can no
longer list or claim queued jobs, and accepts only a hashed, short-lived
assignment capability through the private runner-control boundary. The durable
schema now records provider/sponsor versions, immutable runs, logical
computers, orchestrator claims, physical assignments, operation receipts, and
run event history. A runner receives an immutable Company File base plus a
job-private writable checkout; its output becomes either a verified CAS
publication or a durable review proposal, never a shared writable NAS tree.

Step 1 deliberately ends at the durable dispatch boundary. It includes the
Supabase schema, object-authority contracts, authenticated orchestration RPCs,
and fake/local adapter tests. It does not include a deployed model runtime,
native credential bridge, or physical runner provider.

The following transitional assumptions must be removed in step 2 before
autonomous execution can be claimed:

- Electron directly claims attended turns and wakes and executes them locally;
- production session and routine UI still needs to provision the durable
  sponsor/compute-identity path rather than the legacy local lane;
- the trusted native credential bridge and managed provider must be deployed;
- connector and model credentials can still be machine-local;
- room delivery and some trigger/configuration migration paths still depend on
  an open desktop;
- `SESSIONS.md` describes consumer subscriptions and a sponsor's computer as the
  permanent design center.

Until a dispatcher and at least one Qorpera-managed execution provider are
deployed and tested, the cloud layer provides cloud-authoritative session and
orchestration state but not autonomous model execution while all member
computers are offline.

The mandatory two-member, two-provider release gate is defined in
`NATIVE-SUBSCRIPTION-ACCEPTANCE.md`. Local contract tests and safe failure when
the native bridge is absent do not satisfy that gate.
