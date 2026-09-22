# Runtime: agent-to-agent messaging in the Grok Bot shape (bundle v70)

Date: 2026-09-22. Branch `fable/agent-messaging`. Contract 14.6 and the 8.1
Agent row amended the same day. Design review and Jonas's decision:
`~/Documents/Codex/2026-09-13/take-over-the-qorpera-runtime-work/outputs/AGENT-MESSAGING-DESIGN-20260922.md`.

## What was wrong

`send_coworker_message` delivered, but the recipient woke in a run with no
conversation (`session_id := null`), under a forbidden mouth
(`qorpera_wake_policy_value('agent')` = forbidden/forbidden/0), and
`qorpera_wake_ancestry` refused every message back to an agent already in the
chain. Nothing reached any thread. Members saw an agent "working" and then
nothing. The 2026-09-06 coworker-cycle proof had accepted exactly that.

## What this bundle does

| Piece | Where |
| --- | --- |
| Pair transcript: one company-audience session per unordered pair of agents (`execution_scope.agentPair`, `agentPairKey`), view-only, created on first message, closed when either agent leaves | `20260922220000_runtime_agent_messaging.sql` §1, `qorpera_agent_pair_session_internal`, `qorpera_agent_thread_on_staff` |
| Peer message = one kernel-written event in that transcript (`qorpera.peer-message/v1` inside a runner-transcript entry, no run execution identity, so it is never one of the sender's public sends) | `qorpera_append_kernel_session_event`, `qorpera_send_coworker_message` |
| Chips: `session_info` `qorpera.peer-link/v1` in the sender's thread (`out`) and the receiver's thread (`in`), no text | same |
| Receiver wake carries its own shared thread; policy `pair` = initial forbidden, final optional, silence allowed, max 2 | `qorpera_pin_wake_occurrence`, `qorpera_wake_policy_value`, `qorpera_runtime_wake_policy_internal` (text patches) |
| Hop budget replaces the visited-agent fence for coworker wakes: `causal_hop_count`, 6 per exchange, 20 per pair per hour; a refusal leaves `qorpera.peer-budget/v1` in the transcript | `qorpera_coworker_wake_ancestry`, `qorpera_wake_authorized`, send function |
| The woken agent reads the exchange so far (`payload.transcript`, last 12) | `qorpera_read_native_wake` |
| Runtime: parser accepts the pair policy and an agent wake with a session; envelope validates `pairSessionId`/`pairEventId`/`transcript`; tool description and coworker wake protocol rewritten | `packages/runtime/src/cloud-wake-bus.ts`, `cloud-native-company-context.ts` |
| Web: chips in the thread, the pair transcript panel over the thread (both figures, ⇄, bubbles under the speaker's name, lock line, Close Chat), budget line, rail never lists pair transcripts | `packages/web/src/app/views/pair-transcript.ts`, `conversation.ts`, `shell.ts`, `cloud/transcript.ts` |

Unchanged: file-event and routine fences (a message → file → ancestor cycle
stays fenced), workers (Order 5) and their bus, group chats, the company wake
ceiling and founder stop.

## Proofs

- `supabase/tests/380_runtime_agent_messaging.test.sql`: transcript session,
  peer event without a send row, both chips, wake in the receiver's thread with
  the pair policy and the transcript, one allowed public send, member read of
  the transcript, member post refused, six hops then a refused seventh with the
  budget line, self-send refused, departure closes the transcript.
- `supabase/tests/300_runtime_wake_bus.test.sql`: coworker section rewritten
  (reply is one more hop; the agent a file woke may answer the file's author).
- `packages/shell/test/cloud-wake-bus.test.ts`: pair policy, new envelope
  shape, legacy shape, rejections. `packages/web/test/peer-messages.test.ts`:
  projection of peer messages, chips, budget lines.

## Rollout order (coordinator)

1. Runtime bundle v70 must be the active bundle on every runner **before** the
   kernel produces the new wake shape: a v68 runner rejects an `agent` wake
   with a session. The parser accepts both shapes, so the bundle can go first.
2. Then `20260922220000_runtime_agent_messaging.sql`, then the activation
   `20260922221000_runtime_bundle_activation_v70.sql`.
3. Web deploys itself; the chips render only once the kernel writes them.
4. Live proof: member asks A in A's thread; A messages B; B's thread shows
   "Message from A", A's shows "Messaged B"; open the chip, read both sides;
   B's answer appears; a thanks loop stops at the sixth message with the line.

## Review round 1 (2026-09-22, eight findings, all fixed)

Pre-v70 coworker occurrences (hop 0) keep the old chain rule instead of failing
the hop check; pair-transcript creation takes an advisory lock so two first
messages cannot race the unique index; the hourly budget has a partial index;
the admission trigger validates the session the send passed instead of deriving
it; budgets are evaluated before any session is created or touched; the web
panel stops polling in a hidden tab; the unused `agentPairOf` helper is gone;
test 380 gained the hourly limit, the legacy hop-0 ancestry and the admission
check. Bundle re-cut to `6a79ff33…`, guest provider host `42832a41…`.

## Review round 2 (2026-09-22, four findings, all fixed)

One chain rule, `qorpera_coworker_chain`, now serves both the send (receipt) and
admission (fence) and is tested directly, including the 16-agent cap; the send
reads an agent's existing open thread before creating one; the transcript panel
loads on every open and returns focus to the chip that opened it. Bundle
re-cut to `97605c74…`, guest provider host `d53495cf…`.

## Review round 3 (2026-09-22, three findings, all fixed)

Threads are resolved and their chips written in one global order (agent id,
then session id), so simultaneous sends around a ring of agents cannot
deadlock; a refused hop between two agents with no transcript writes its line
into the sender's own thread (tested with a six-hop relay that then reaches a
third agent); the panel loads once on first open. Bundle re-cut to
`7384be69…`, guest provider host `5f61e587…`.

## Second cut: held delivery (bundle v73, 2026-09-23)

`send_coworker_message` takes `priority` (default true). With `priority: false`
the message is written into the pair transcript (marked held) and both chips
are dropped, but no wake is created: the row waits in
`qorpera_pending_peer_messages` and `qorpera_read_native_wake` hands the oldest
twelve undelivered ones to the recipient at its next wake of any kind, except a
blank worker or an office continuation, as `payload.heldMessages` (claimed by
that run; a re-read by the same run sees the same; a later run does not). Held
messages extend no chain but count toward the pair's hourly budget. The
runtime parser accepts `heldMessages` on every wake kind, sends `p_priority`
only when false (a pre-v73 kernel still understands the call), and accepts the
`held` receipt; the web shows "Read at B's next turn" under a held message.
Migration `20260923000000_runtime_held_peer_messages.sql` drops the
four-argument send and creates the five-argument one; the priority digest is
unchanged so receipts from before the cut still replay. Test
`supabase/tests/381_runtime_held_peer_messages.test.sql`. Rollout: bundle
before the SQL, as for v70.

## Not in this cut

Member notifications beyond the rail's unread marker, attachments in peer
messages.
