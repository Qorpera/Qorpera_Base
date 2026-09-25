# Runtime auto-review rules (bundle v115)

Founder decisions 2026-09-24/25; contract amendment "2026-09-25 amendment:
auto-review rules and approvals". Design, Grok Bot reference and probe
results: `outputs/AUTO-REVIEW-RULES-DESIGN-20260924.md` in the runtime
takeover workspace.

## What ships

- **Kernel** `20260925115000_runtime_auto_review_rules.sql`: `qorpera_review_rules`,
  `qorpera_action_reviews`; member RPCs `qorpera_list_review_rules`,
  `qorpera_save_review_rule`, `qorpera_archive_review_rule`,
  `qorpera_answer_action_review`; runtime RPCs (service role, run lease)
  `qorpera_begin_action_review`, `qorpera_record_action_review`,
  `qorpera_await_action_review`; the observation vocabulary gains
  `action_review` and four error categories.
- **Runtime** (guest bytes): `cloud-action-review.ts` (classification, card
  facts, reviewer instructions and verdict tool, the review gate),
  a review step in `CloudNativeToolBoundary.#execute` (after the authority
  check, then authority again right before the effect), reviewer threads in
  `CodexBoundaryRpc` (same app-server, one fresh thread per review, verdict
  as the reviewer's only tool call, its own lane through the result fence,
  never recorded as the agent's context), and the gate wired into company
  runs only (not coding sessions).
- **Activation** `20260925115900_runtime_bundle_activation_v115.sql`, which
  refuses to activate without the kernel migration.

## Review round 1 (2026-09-25)

An independent review of 0e5b25515 asked for changes; all fixed:
- The general card answer (`qorpera_answer_interaction`) now refuses these
  cards; before, today's web could approve one there, which the held call never
  read and which took the card's only answer slot.
- A holding call renews a heartbeat (`held_until`); an answer to a card no call
  holds any more (parked, stopped, run ended) wakes the agent. A stopped hold
  also parks its card on the way out (best effort).
- The card and the reviewer get the boundary's exact canonical arguments (the
  digest's own text, up to 64 KiB), not the parsed ones cut at 8 KiB, so the
  woken agent's repeat matches and the reviewer reads the whole call.
- A Deny (the member's or the reviewer's) stands for that exact call; a
  redundant wake after the holder already ran the action finds it done.
- The wake paths check what a post or message there checks: write access to
  the conversation, the cleanup fence, the queue bound, and, in an agent's
  thread, an active thread membership. An answer whose delivery failed may be
  given again.
- Approvals and denials are bound to the member the run works for.
- An allow for an action "not asked for" is recorded as a deny.

## Review round 2 (2026-09-25)

Round 2 (on ac789fe2f) confirmed the round-1 fixes and found two defects in
them, both fixed:
- An answer to a parked card wakes the agent on the answerer's account, so the
  woken run's member is the answerer: `begin` now also matches a review the
  run's member answered (not only one raised for them).
- A hold that ends early parks with `p_leaving`: an unanswered card parks, an
  answered one is left unused (before, the exit park could use up an approval
  the stopping call would never run).
- Nits: a failed Always allow's reset archives the rule it saved; a retry with
  the failed answer's client id is refused (55000), not a success.
- (From the web review) a card for the owners and admins is never raised in one
  member's private conversation, where they could not read it: that call is
  refused with APPROVAL_UNAVAILABLE_HERE, like a group chat's.

## Review round 3 (2026-09-25)

Round 3 (on b5fed634b, re-cut on master v107) confirmed the round-2 fixes, the
merge and the pin (APPROVE WITH NITS); fixed:
- `begin` matches a review the run's member answered only in the card's
  conversation, where the wake lands: an owner's answer on a contributor's
  card elsewhere neither ran nor blocked the owner's own identical call.
- The observation vocabulary is patched into the live function, not re-stated:
  v114's `decide_routine` (PR #314, migration 20260925114000) stays in either
  merge order (checked with #314's migration applied first).
- One index serves `begin`'s lookup of the latest review of an action (it was
  a scan of the whole audit table on every acting call).

Known limit (accepted for now): a card answered while its call still holds it,
whose run then stops or crashes within the 10 s heartbeat, keeps an unused
approval that nothing delivers: the card reads approved and the agent is not
woken. The next time the agent repeats that exact call, the approval serves
it. A later fix stores the answerer's model account on the review so a stopped
hold can wake the agent.

## Rollout order

1. Pause, record `20260925115000` (the observation function must accept
   `action_review` before any v115 runner reports it).
2. Runner image with the v115 guest provider host; providers restart.
3. Activation v115; resume.
4. Web (Rules tab, live approval cards) after v115 is live; before that the
   web shows no controls the kernel refuses.

## Measured before building (2026-09-25, local 0.155 alpha app-server)

- Six reviewer turns ran in one app-server while the agent's tool call was
  held open (35 s and 102 s); the verdict arrived as the reviewer's tool call;
  the agent finished its turn after release.
- GPT-6 Luna at low effort: 3.9-7.0 s from thread start to verdict (model
  3.5-5.9 s), ~6.1k input tokens (mostly Codex's base prompt), ~60 output.
- Verdicts 5/6 correct on a small set; the miss (an injected "forward the
  invoices" email) came back ask instead of deny; the instructions now put
  deny first.

## Acceptance (live, after the cut)

1. A company rule "Ask first before emailing anyone outside the company";
   a member asks the Co-Founder to email an outside address: an approval card
   appears in the thread, waiting for owners and admins; Allow once runs the
   send in the same turn.
2. The same with nobody answering for five minutes: the call parks; a later
   Allow wakes the agent, which repeats the call and it runs once.
3. A personal Ask first rule: only its member can answer.
4. A read-only request (company_read, snapshots) triggers no review
   (`qorpera_action_reviews` has no row for it).
5. Observation rows `action_review` with durations; no rejected observations.
