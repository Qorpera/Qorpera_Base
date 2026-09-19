# Step 8: scheduler, listeners, agent-set routines and agent hiring

Date: 2026-09-19/20. Branch point: `dfdb64ce3` (master, bundle v37).
Status: source, SQL proofs and live-model behavior screens. Not deployed; no
live acceptance on the nodes yet.

## What already existed (built for Order 3)

The wake bus needed a working scheduler, so most of contract 16.3 was already
source-implemented and proven: schedule triggers (interval, weekly wall clock,
window and months) with IANA time zones and DST handling in the orchestrator's
reconciler, deterministic occurrence keys with a cursor compare-and-set,
catch-up coalescing, Company File listeners that walk the revision chain once
with a causal-loop fence, the listener-is-not-a-cron invariant, and the routine
wake policy with valid silence. See [the wake bus record](RUNTIME-STEP-3-WAKE-BUS.md).

What was missing for Order 8: an agent could not give itself a routine, nothing
expired, there was no quiet policy, nothing suspended a routine whose account
stopped working, a responsibility's cadence was recorded but never acted on,
and routines are control-plane rows rather than Company File documents.

## Built in this change

### Agents set up their own standing work (founder decision 2026-09-19)

`manage_routine` (tool) -> `qorpera_manage_agent_routine(p_binding, p_request)`:
list, upsert, pause, resume, remove. The routine always belongs to the calling
agent; the model cannot choose another agent, a requester, a model account or a
computer. **No member approval is involved.** The operation uses the ordinary
run authority chain (locked run, path actor, read-set assertion, wake work gate,
operation receipt with exactly-once replay), and a file listener may only watch
a path the agent and its requester may read. Limits: 32 live routines per
agent, one trigger per routine, five minutes minimum interval.

The tool offers the three shapes people use (`every`, `weekly` with a Monday to
Friday default, `file_change`) and compiles them to the scheduler's closed
trigger forms; the trigger id is host-owned.

**Model account.** An unattended run needs an account whose owner allows
unattended use. That is an account setting made once, not a per-routine
approval. The routine pins the account that already runs the agent when it
qualifies, else the requester's most recent qualifying account. When none
exists the routine is saved paused (`needs_model_account`) and the member is
told once per agent. When a member later allows unattended use, every waiting
routine in the company starts by itself on that account.

### Scheduler rules as code (contract 16.3)

| Rule | Enforcement |
| --- | --- |
| Expiry, finite watches | `expires_at`, `max_occurrences`; status `expired`. The control-plane tick sweeps expiry; the occurrence that reaches the limit expires the routine; a later slot is refused. One status stops both trigger types, because the reconciler lists active routines only and a listener cursor is active only while its routine is. |
| Quiet hours | Per routine `quietHours {start, end, timeZone}`, including windows across midnight. An occurrence admitted inside the window keeps its identity and waits (`not_before`) for the window's end. |
| Weekday default | A wall-clock routine runs Monday to Friday unless the agent names other days. |
| Authorization suspension | Three occurrences in a row cancelled because the account can no longer run unattended pause the routine (`authorization_failed`) and create one durable notification for the account owner. A materialized occurrence resets the count. |

### Responsibility cadence (contract 14.3, Order 8 placement)

An active responsibility with a recognised `attentionCadence` (`hourly`,
`daily`, `weekly`, `every N minutes|hours|days`, at most one week) owns one
schedule routine that wakes its accountable agent with a review intent and
optional reporting. The first review is one interval from now. The routine
follows the responsibility in the same transaction: a new cadence is a new
version, a new owner is woken instead of the old one, a pause pauses it, a
retirement retires it, and a free-text cadence schedules nothing. The review
runs on the accountable member's unattended account, else the company owner's,
else the recorder's. The agent sees these in its routine list as read-only so
it does not duplicate them. Existing responsibilities are backfilled.

### Agents propose coworkers (contract 14.1, 14.2)

`hire_agent` writes the canonical fourteen-field agent document through the
governed path gateway. An agent document is always proposal-gated, so nothing
exists until an authorized member approves; the existing projection then
creates the agent, its default read grant and its single first-run wake, and
enforces that a creating agent cannot delegate authority it lacks. The new
agent starts with no grants beyond the default.

Path authority gained one narrow rule, guarded by a migration-time assertion
that agent documents are still proposal-gated: any active agent may propose a
new agent document while holding only the default read grant; only the company
Co-Founder may propose a change to an existing one; the requesting member's
own write authority still applies.

## Proofs

Real PostgreSQL (task-local 18.6 on `company41-node-02`; CI runs the pinned
17.6 image), every migration applied, then:

- `370_runtime_agent_routines.test.sql`: acknowledgement gate, creation with
  no member step, same agent and account, exact replay, versioning, listing,
  closed request (no other agent, no sponsor, no trigger id, no one-minute
  loop), control-plane-only execution, pause/resume/remove, finite watch,
  expiry by tick, quiet-hour deferral, suspension with one notice, and the
  no-unattended-account path.
- `375_runtime_agent_hiring.test.sql`: a read-only agent proposes a coworker;
  no staff row and no file before approval; ordinary paths stay closed.
- `380_runtime_responsibility_cadence.test.sql`: cadence vocabulary, creation,
  follow-the-responsibility transitions, read-only visibility, automatic start
  when unattended use is allowed.
- The other 52 SQL test files pass unchanged with these migrations. Six files
  fail identically with and without them on that host (loopback connections
  and time zone data of the task-local server); CI is authoritative.

Unit tests: 11 routine-tool, 8 hiring-tool, plus the runtime tool-list and
prompt composition tests.

Live-model screens (same runner as the Step 10 passes, synthetic effects):
a new hire told "make sure we never miss a bad week" set up its own
file-change watch with quiet reporting; "every weekday morning, only tell me if
more than 10 wait" became one business-day routine in the member's time zone;
"check again tomorrow at 09:00" became a one-occurrence watch; a one-off
question created nothing; with no unattended account the agent said so plainly.
The Co-Founder proposed an onboarding owner with a real job description and
said it awaits approval, did not hire for a one-off task, and still argued
against three sales hires that conflict with direction.

## Bundle

Runtime bundle v38, `50078458e19a2ed989dfbff3b999d73cac3ff903387c7411c3f9c6bbbfbff630`
(`20260920003000_runtime_bundle_activation_v38.sql`). Guest artifact pinned from a
Linux x64 build on `company41-node-02`: `qorpera-native-provider-host.mjs`,
1,338,913 bytes, `78ff4f0172804a896befeffefae1a12d279c44a96f5c73de8b53b6c1f4357313`.
Seven bundle, guest-package and SQL-harness tests passed there; SQL context
parity passed after all 286 migrations. `npm run check` passes. If master ships
another activation first, allocate the next version and regenerate; never
relabel a shipped bundle.

## Not built; Order 8 stays open

1. **Routines as Company File intent with projection consistency.** The order
   table asks for "Company File intent plus one compiled trigger". Today a
   routine is a control-plane row. Organization documents are projected only on
   the approval and member-command paths; a routine that needs no approval
   would need a projection hook in the native commit path and the object
   gateway supplying document text there. That touches the most fenced part of
   the kernel and deserves its own reviewed design.
2. **Vendor listeners** (webhook verification, channel membership, identity
   gating) depend on Order 7 connectors and secret custody for listener secrets.
3. **Listener operation filter** (create/update versus delete) is reported in
   the payload but cannot be subscribed to.
4. **Member-saved routines** do not yet expose expiry or quiet hours in the web
   client, and the web client does not show agent-made or responsibility
   routines as such.
5. **Live acceptance**: clients closed, an agent-made routine firing on the
   node, a cadence review running silently, a hire approved from the web and
   its first run. Needs the migrations, bundle v38 and the runner image rolled
   out through the existing lane.
