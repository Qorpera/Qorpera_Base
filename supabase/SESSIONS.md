# Session arbitration

**Status:** Contract. The migration `20260818007000` implements the queue; the
shell adopts it next.
**Problem it solves:** on 2026-08-18, two machines opening the same staff agent
minutes apart each minted a session and ran a duplicate kickoff — one agent,
two diverging conversations. Trail replication was healthy; nothing consulted
it before writing.

## Principles

**The cloud owns the conversation.** A session exists because a row says so,
and there is at most one open session per staff agent per profile — enforced
by a partial unique index, not by convention. Opening an agent means adopting
the open session or atomically creating it; a client never mints locally.

**Work is a queue, not a lease.** Every user message — and the kickoff itself —
is a queue row. Executing is claiming: an atomic per-turn claim with a short
expiry, the same primitive the runner jobs use. Two machines racing to wake an
agent both enqueue nothing and claim once; the winner runs the turn, the loser
renders it. An idle agent holds no locks and no heartbeats — just rows.
Kickoff-as-queue-item is what makes the duplicate-kickoff race impossible
rather than unlikely: creation and the kickoff row land in one transaction,
so there is exactly one kickoff to claim, ever.

**One context window, attributed.** All members' inputs interleave into the
one session, so everyone shares the agent's context by construction. Every
input carries its author, and prompts label speakers — the agent is in a group
conversation and must know who said what.

**Two lanes with different guarantees.** Durable events (messages, outputs,
approvals) go through the queue and events tables: written once, kept forever,
replicated. Presence (typing indicators, who-is-viewing) is fire-and-forget
pub/sub: lossy by design and never stored. Typing indicators must never
touch the durable lane.

## Primary and backup

Durable session state lives on the primary (managed Postgres today; the NAS
when it takes that role) and replicates asynchronously to the backup cloud
(Cloudflare). Clients hold a connection to exactly one of them.

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
- `qorpera_claim_session_turn(session, claimant, lease_seconds)` — claims all
  pending inputs as one turn iff no unexpired claim is in flight; returns the
  batch or nothing. Expired claims are claimable again (executor died).
- `qorpera_renew_session_turn` / `qorpera_complete_session_turn` — lease
  upkeep and completion, claimant-scoped.

Outputs continue through the existing session-event and trail mechanisms; the
queue governs only who may produce them.
