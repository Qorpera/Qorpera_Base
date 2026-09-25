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
