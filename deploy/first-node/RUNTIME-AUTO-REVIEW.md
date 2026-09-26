# Runtime auto-review rules (bundle v130)

Founder decisions 2026-09-24/25; contract amendment "2026-09-25 amendment:
auto-review rules and approvals". Design, Grok Bot reference and probe
results: `outputs/AUTO-REVIEW-RULES-DESIGN-20260924.md` in the runtime
takeover workspace.

Re-slotted 2026-09-26 from v115 to **v130** (confirmed by the coordinator):
master took v126–v129 first and its `20260925115000` is another migration.
Migration `20260926130000`, activation `20260926130900` (previous v129, exact
predecessor bundle `4b74abe4…`, every master guard kept). #314 (dynamic
routines) follows as v131; the `decide_routine` handling works in either order.
Earlier notes below keep the numbers they were written with.

## What ships

- **Kernel** `20260926130000_runtime_auto_review_rules.sql`: `qorpera_review_rules`,
  `qorpera_action_reviews`; member RPCs `qorpera_list_review_rules`,
  `qorpera_save_review_rule`, `qorpera_archive_review_rule`,
  `qorpera_answer_action_review`; runtime RPCs (service role, run lease)
  `qorpera_begin_action_review`, `qorpera_record_action_review`,
  `qorpera_await_action_review`, `qorpera_add_agent_review_rule`; the
  observation vocabulary gains `action_review`, the tool `add_review_rule` and
  four error categories.
- **Runtime** (guest bytes): `cloud-action-review.ts` (classification, card
  facts, reviewer instructions and verdict tool, the review gate),
  a review step in `CloudNativeToolBoundary.#execute` (after the authority
  check, then authority again right before the effect), reviewer threads in
  `CodexBoundaryRpc` (same app-server, one fresh thread per review, verdict
  as the reviewer's only tool call, its own lane through the result fence,
  never recorded as the agent's context), and the gate wired into company
  runs only (not coding sessions).
- **Activation** `20260926130900_runtime_bundle_activation_v130.sql`, which
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

## Review round 5 (2026-09-25, own review of 47ef78dee)

Found in my own review of the approved head and fixed:
- `decide_routine` (v114, PR #314, merged before this) is internal. Unlisted it
  would have been reviewed as an outside action, and a routine run parks at
  once, so a dynamic routine's decision would wait on a card and its run count
  as failed.
- The reviewer reads a card answer in plain words, and, when members started
  the run, their latest three earlier messages in the conversation (bounded,
  members' own words only: never the agent's messages, data or tool results).
  Before, a run woken by a card answer showed the reviewer only the answer's
  raw data, so its next steps were judged against no request at all.
- A denial (the reviewer's or a member's) stands in its run, and in its
  conversation until a member writes there again; before, it stood forever
  for that member and exact call, with no way to ask again. The retry then
  waits for a click on a card (see the parity section and round 6).
- A card still waiting holds the same call only in its own conversation;
  elsewhere a new card is raised where the member can see it.
- The agent tool `add_review_rule` (founder decision D4): an agent adds an Ask
  first rule for the member it works for, when asked. Kernel
  `qorpera_add_agent_review_rule` (run lease, company path lane), observed as
  `add_review_rule`. The contract text said this existed; it did not.
- Card titles for resuming and ending a routine.

## Grok Bot parity (2026-09-25)

`outputs/auto-review-parity/` in the runtime takeover workspace runs 23
scenarios through the real review gate (these instructions, prompt and
parsing) with GPT-6 Luna at low effort on a local Codex app-server, then
records every verdict through the real `qorpera_record_action_review` in a
local Postgres (layering, who answers, Always allow). Grok's expected outcome
comes from its docs and from Grok Teacher (asked 2026-09-25 10:34 local).

Final pass: every scenario matches Grok except one founder decision (D1: a
company Allow rule that covers a built-in check lifts it; Grok hands payment
to the human whatever the rules). Changes the parity run led to:
- Only a company Allow rule lifts a built-in check; a member's own never does
  (Grok: personal rules only make behaviour stricter).
- The reviewer asks on its own when unsure the member wants an irreversible
  step, instead of denying (Grok: the reviewer may allow, ask or deny with no
  rule matching); it denies only what clearly works against the request.
- Hiring or instructing the company's own agents is no access change.
- The reason is in English, or Danish when the request is Danish (Danish rules,
  domains and currencies had pulled English requests into Danish).
- A call denied earlier in a conversation and retried after the member wrote
  again always becomes a card (Grok: a "yes" in chat is not enough by itself;
  the retry puts a card in front of the human); round 6 keeps it with the
  owners and admins where the company held it.

## Review round 6 (2026-09-25, on 31a9374e5)

A fresh independent review asked for changes; fixed:
- A retry after a denial never moves the answer down to a plain member: it
  stays with the owners and admins when the fresh review still finds it not
  asked for, or when they answered this call before (a company rule, a money,
  terms, deletion or access check). Before, a retry judged "not asked for"
  went to the member, so a contributor could approve what an owner denied.
- `decide_routine` is internal only without `intent` or `title`; a decision
  that rewrites the routine's instructions is reviewed like a routine change
  (later runs read those instructions as their request, so an injected rewrite
  could otherwise make an exfiltration look requested). A refused rewrite tells
  the run to decide again without it, so its decision is still made.
- A card answer's chosen option reads as an option the agent wrote, not the
  member's own words; the reviewer is told so.
- Nits: the reviewer's own-doubt ask excludes what a built-in check covers;
  the retry hint says a new message is needed (a card answer does not count);
  a full rule list refusal is tested.

## Review round 7 (2026-09-26, on fdc7aeb65, re-cut as v130)

APPROVE WITH NITS; the two low findings and the draft titles fixed:
- A dynamic routine's rewrite of its instructions raises no card (its approval
  could never be applied: `decide_routine` exists only in that routine's run);
  the run decides without the rewrite.
- A sent email draft reaches the reviewer as "the email the agent drafted went
  to …, subject …", never with its body read as the member's words.
- Gmail draft tools have card titles, and a list of recipients shows as the
  card's target.

## Rollout order

1. Pause, record `20260926130000` (the observation function must accept
   `action_review` before any v130 runner reports it).
2. Runner image with the v130 guest provider host; providers restart.
3. Activation v130; resume.
4. Web (Rules tab, live approval cards) after v130 is live; before that the
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
