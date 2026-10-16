# Session arbitration

**Status:** Control-plane contracts implemented. Migrations `20260820001000`
and `20260820002000` bind queued input to immutable Company File, staff,
sponsor, and run revisions. The desktop adopts and renders the company session;
Supabase owns orchestration, and a future execution dispatcher delivers assigned
work to Qorpera-managed computers.
**Problem it solves:** on 2026-08-18, two machines opening the same staff agent
minutes apart each minted a session and ran a duplicate kickoff — one agent,
two diverging conversations. Trail replication was healthy; nothing consulted
it before writing.

## Principles

**The cloud owns the conversation.** A session exists because a row says so,
and there is at most one open conversation per staff agent *and audience
scope* per profile — one company-audience session and one member-private
session per writable member — enforced by partial unique indexes
(`20260828019000_member_private_staff_sessions.sql`), not by convention.
Opening an agent means adopting the open session for that audience or
atomically creating it; a client never mints locally. (Amended 2026-09-01
per runtime contract sections 14.2, 14.7 and 23; the earlier "one open
session per staff agent" rule is superseded.)

**Work is a queue, not a lease.** Every user message — and the kickoff itself —
is a queue row. Executing is claiming: an atomic per-turn claim with a short
expiry, the same primitive the runner jobs use. Two machines racing to wake an
agent both enqueue nothing and claim once; the winner runs the turn, the loser
renders it. An idle agent holds no locks and no heartbeats — just rows.
Kickoff-as-queue-item is what makes the duplicate-kickoff race impossible
rather than unlikely: creation and the kickoff row land in one transaction,
so there is exactly one kickoff to claim, ever.

**One context window per audience, attributed.** Within the company-audience
session all members' inputs interleave, so everyone in that audience shares
the agent's context by construction. Every input carries its author, and
prompts label speakers — the agent is in a group conversation and must know
who said what. A member-private session is a separate conversation under that
member's audience and private-scope rules; its context never leaks into the
company audience or another member's private session (contract section 14.2,
acceptance item 20).

**Two lanes with different guarantees.** Durable events (messages, outputs,
approvals) go through the queue and events tables: written once, kept forever,
replicated. Presence (typing indicators, who-is-viewing) is fire-and-forget
pub/sub: lossy by design and never stored. Typing indicators must never
touch the durable lane. Lossy is not public: the presence topic is a private
Realtime channel (migration `20260819011000`), authorized against profile
membership through RLS on `realtime.messages` — receive and publish both
require membership, so the anon key alone can neither watch nor spoof.

## Primary and backup

Durable session metadata lives in the authoritative Supabase/Postgres control
plane. Immutable attachments, artifacts, Company File objects, and encrypted
checkpoints live in object storage/NAS. The object store never becomes a SQL
primary, and neither authority requires an open desktop.

Failover is automatic but **never client-decided**. A client that fails ten
consecutive retries against the primary does not promote anything — it
re-resolves the primary pointer from the referee, a minimal always-up service
colocated with the backup. The referee flips the pointer only after its own
sustained health-check failure of the primary, and every flip increments an
epoch. Writes carry the epoch; a deposed primary that comes back sees a
higher epoch and demotes itself to replica rather than accepting writes.
When a session resumes under a new epoch, a system event is appended to the
thread so every member sees the swap where they are already looking.

The failure a client observes is not evidence the primary is down — it is
evidence that *this client* cannot reach it. Only the referee's view counts,
because two arbiters accepting turns is the fork bug again, at cloud scale
and in permanent form. Until the backup path exists end-to-end, the backup
buys durability, not availability: a paused session is an inconvenience, a
forked one is corruption.

## Server surface (20260818007000)

- `qorpera_ensure_staff_session(environment, staff_agent, client_session_id, title)`
  — adopt-or-create, atomic; creating also enqueues the kickoff row in the
  same transaction. Returns the session and whether this call created it.
- `qorpera_append_session_input(session, client_input_id, kind, body)` —
  idempotent by client input id; any member with write access.
- `qorpera_claim_session_turn(session, claimant, lease_seconds,
  company_snapshot, staff_version)` — claims all pending inputs as one turn
  iff no unexpired claim is in flight and the supplied revisions are still
  current; returns the batch or nothing. Expired claims are claimable again
  (executor died).
- `qorpera_renew_session_turn` / `qorpera_complete_session_turn` — lease
  upkeep and completion, claimant-scoped.

Legacy sweep D14 (20260930413000) dropped the turn claim and the v2
renewal and completion, with the quarantine, status and recovery calls and
the rest of the hosted primary's executor. A folder-v2 company has no head
snapshot to pin: its conversations are rooms, and their runs are execution
runs.

Outputs continue through the existing session-event and trail mechanisms; the
queue governs only who may produce them.

Operational trails were registered through `qorpera_create_shared_session_v4`.
Their execution scope carried the exact claimed Company File and staff
revisions, so delayed trail synchronization could not silently re-pin a finished
wake to newer state. Legacy sweep D15 (20260930414000) dropped it with the
other plain session creators, the turn and wake operation receipts and the
account events.

## Wake arbitration (20260819012000)

Autonomous wakes — scheduled routines, trigger events, durable coworker mail —
are admitted as durable control-plane occurrences before compute is selected.
Wakes are claimed execution runs, not per-desktop timers.

Each wake occurrence has one **deterministic key**, derived from the work
itself and never from physical runner state: scheduled jobs key on the schedule's occurrence
(weekly instant, anchored slot index, or the epoch grid for unanchored
intervals), trigger wakes on the source's stable event id, mail wakes on the
message id. Claiming is atomic with a short lease, renewed while the wake
runs. The winner executes; a loser consumes the occurrence locally without
running. Completion makes the occurrence final on every machine; a lease that
expires without completion is a dead executor, and the occurrence is
claimable again.

- `qorpera_claim_wake_v2(environment, wake_key, claimant, lease_seconds,
  staff_agent, company_snapshot, staff_version)` — insert-or-takeover only
  when the supplied Company File and staff revisions are still current; the
  holder's own re-claim refreshes the lease so a failed spawn retries
  idempotently. Losers learn why: `in-flight` (someone is running it),
  `already-run` (it is finished forever), or `stale-revision` (sync before
  retrying).
- `qorpera_renew_wake` / `qorpera_complete_wake` — lease upkeep and
  completion, claimant-scoped.

Legacy sweep D14 (20260930413000) dropped these three with the turn claim.

Manual "run now" is founder intent recorded as its own cloud run. Every
autonomous occurrence is likewise admitted in the cloud before a computer is
selected. An unreachable control plane leaves the occurrence pending; it never
executes an unclaimed local copy.
Completed occurrence keys retain compact tombstones so a delayed duplicate can
never become new work after artifact/history retention expires.

## Execution dispatch

The session-turn and wake claim RPCs above were compatibility primitives for
the temporary desktop adapter, and legacy sweep D14 dropped them. They were
never the deployed cloud scheduler. The
normative architecture is [CLOUD-CONTROL-PLANE.md](CLOUD-CONTROL-PLANE.md), and
provider authorization is tracked separately in
[PROVIDER-CAPABILITY-MATRIX.md](PROVIDER-CAPABILITY-MATRIX.md).

Every runnable input/occurrence must become an immutable execution run with a
versioned sponsor, Company File snapshot, staff revision, and transcript
boundary before dispatch. Supabase—not Electron, the dispatcher, or a runner—
is the orchestration authority that claims the work and records one compatible
runner assignment. A runner that disappears can be replaced without changing
the company session or run identity.

The temporary local adapter is permitted only behind the same assignment
interface. It may execute while a member desktop is open, but it cannot select
work or establish machine ownership of a company session. Until the future
dispatcher and a Qorpera-managed computer provider are deployed and tested,
queued work with no temporary adapter online remains visibly pending; the
product does not claim all-machines-offline execution.
