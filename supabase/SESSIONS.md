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
touch the durable lane. Lossy is not public: the presence topic is a private
Realtime channel (migration `20260819011000`), authorized against profile
membership through RLS on `realtime.messages` — receive and publish both
require membership, so the anon key alone can neither watch nor spoof.

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

## Wake arbitration (20260819012000)

Autonomous wakes — scheduled routines, trigger events, durable coworker mail —
fire on every machine that has the company open, so without arbitration two
machines run duplicate autonomous sessions: the fork bug, on the proactive
lane. Wakes are therefore claimed rows, the same primitive as session turns.

Each wake occurrence has one **deterministic key**, derived from the work
itself and never from local run state, so every machine names the same
occurrence identically: scheduled jobs key on the schedule's occurrence
(weekly instant, anchored slot index, or the epoch grid for unanchored
intervals), trigger wakes on the source's stable event id, mail wakes on the
message id. Claiming is atomic with a short lease, renewed while the wake
runs. The winner executes; a loser consumes the occurrence locally without
running. Completion makes the occurrence final on every machine; a lease that
expires without completion is a dead executor, and the occurrence is
claimable again.

- `qorpera_claim_wake(environment, wake_key, claimant, lease_seconds)` —
  insert-or-takeover; the holder's own re-claim refreshes the lease so a
  failed spawn retries idempotently. Losers learn why: `in-flight` (someone
  is running it) or `already-run` (it is finished forever).
- `qorpera_renew_wake` / `qorpera_complete_wake` — lease upkeep and
  completion, claimant-scoped.

Manual "run now" is founder intent on that machine and machine-local events
have no shared identity — both run unarbitrated. An unreachable cloud
degrades to solo behaviour (the wake runs locally) rather than blocking
autonomous work; completed rows are swept after 30 days, long past any
machine's chance to re-derive the same key.

## Executor eligibility (sponsorship, affinity, freshness)

Adopted 2026-08-19 after the first arbitrated two-machine run.

**Subscriptions are the design center.** API-key pricing is roughly a 40x
multiple on subscription intelligence and would flatten the use case, so the
architecture must run on consumer subscriptions permanently — which providers
permit for one user's own agents on that user's own machines, and forbid to
pool across users. Model credentials therefore stay **per member, never a
company pool**: the vault maps each member to their own connections and hands
tokens only to executors acting on that member's behalf.

**Every agent has a sponsor**: the member whose subscription its configured
model (staff registry `model_provider`/`model_id`, already company state)
runs on. An agent's turns execute only on machines holding its sponsor's
connection for that provider; usage draws down the sponsor's plan limits
exactly as if they ran it by hand.

Three predicates gate a claim, and a machine that fails any of them simply
does not claim — the queue holds the turn for a machine that passes:

1. **Affinity** — this machine can execute the agent's configured provider.
   No claim, no model flapping: the agent keeps one mind regardless of who
   is typing. (The API layer is already replay-safe across executors and
   providers — openai-codex falls back to full input whenever its
   connection-scoped continuation does not prefix-match, and the messages
   API is stateless — so affinity is about identity and terms, not about
   context survival.)
2. **Freshness** — this machine's local trail for the session matches the
   cloud's event head. Claiming with a lagging trail would execute on
   partial context: the silent-clearing failure, moved one layer down.
   Sync first, claim after.
3. **Capability** — write access and a ready, idle child, as today.

A queued turn with no eligible executor online is a **visible** state, not a
silent one: the thread shows who the session is waiting for ("waiting for
<sponsor>'s computer"). Degraded arbitration is likewise surfaced through
the same health channel as the other cloud sync loops — a fallback nobody
can see is a fork factory with better manners.
