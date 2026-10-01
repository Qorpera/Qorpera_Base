# Company folder core, C2: recording reviews

C1b-1 built the review record and the commit's enforcement (RUNTIME-COMPANY-FOLDER-C1B.md §6). An in-house agent's
delegation or deletion unit is denied unless a `qorpera_folder_reviews` row of its run covers it, bound to the change
set's digest. Nothing writes that row yet, so today every such unit is denied (`review_required`).

C2 adds the writer. It comes in two slices:
- **R1, the recorder for reviewed tool calls** (§1–§7, F2). An agent tool whose call the automatic review already
  approved records that approval for the change set the call commits. This is enough for the thin writers W4
  (`hire_agent`, `create_group_chat`, `manage_routine`) and for `decide_routine`'s rewrite.
- **R2, review of change sets no tool call carried** (§8). Cards, answers and parked proposals.

F1 handed the recorder to F2 on 2026-10-01 (registry, "C2's review recorder goes to F2"), with these constraints:
- `qorpera_folder_reviews` and the commit's enforcement (rank 7b, `FOR SHARE`) stay as C1B §6 fixed them;
- the recorder is a run effect through the run entry, and reuses the commit's own change-set digest;
- the layering is the kernel's, in SQL, with rules from `rules/`, and allows by default (founder decision);
- a member's answer takes the review `FOR NO KEY UPDATE` at 7b, after the member prelude and before the conversation;
  the review row has no session foreign key;
- the split into R1 (allow and deny, enough for W4) and R2 (cards, answers, parked proposals).

R1 differs from that split in two ways, for F1 to confirm (§2, *Allow, deny and the card's member*):
- it writes no `deny` rows;
- it writes a card's allow as an ask already answered `allow`, at insert time, so the commit names the member.

Everything here runs only for `folder-v2` companies.

## 1. What already works

The automatic review (v130, RUNTIME-AUTO-REVIEW.md) runs before every acting tool call, `folder-v2` runs included:
- The tool boundary asks `CloudActionReviewGate` before `execute` (`cloud-native-tool-boundary.ts:602-623`). The gate
  classifies the call by tool name (`cloudActionEffect`): `hire_agent` and `create_group_chat` are delegation,
  `manage_routine` is delegation except `list`, `decide_routine` is delegation when it carries `intent` or `title`, and
  `company_delete` is destructive.
- `qorpera_begin_action_review`, `qorpera_record_action_review` and `qorpera_await_action_review` take the run check
  through `qorpera_native_tool_locked_run`, which on `folder-v2` is `qorpera_folder_tool_run` (20260928279470).
- `qorpera_record_action_review` is the kernel's layering, in SQL (20260926130000:339; delegation fix
  20260926210000:78-100; last patched for `folder-v2` in 20260928279560):
  - an action the reviewer finds not asked for never runs on an allow;
  - an Ask first rule wins over an allow;
  - a built-in check (money, terms, deletion, access) asks unless a company Allow rule covers it; for delegation those
    checks never apply, so only an Ask first rule or the reviewer's own doubt asks;
  - a call denied earlier in the conversation asks again only after a member writes there.
- The rules are `qorpera_review_rules_for`: the company's rules and the member's own. On `folder-v2` the company's are
  the index of `rules/*.md` (F2-4, 20260928249190), plus the rows a card's Always allow saved, until C3. With no rule and
  no doubt, the call is allowed.
- An ask raises a card where the member it waits for can see it (`v_card`, 20260926130000:439), and the call holds on
  it, then parks. The answer (`qorpera_answer_action_review`, on `folder-v2` behind the member prelude since
  20260928319670) wakes the agent, whose repeated call is approved once (`consumed_run_id`). An ask where no card can be
  raised is refused (`APPROVAL_UNAVAILABLE_HERE`): "an ask becomes a deny where no card can be raised".
- A denial stands for its run and its conversation (`qorpera_begin_action_review`).

So the verdict on a W4 call is already the kernel's, layered in SQL with the `rules/` index, allow by default. What is
missing is the link from that verdict to the change set the call commits.

## 2. The recorder

```
qorpera_folder_record_review(p_binding jsonb, p_request jsonb) returns jsonb
p_request = { "actionReviewId": uuid, "tool": text, "argumentSha256": hex64,
              "units": [ ...the units exactly as the commit will send them... ] }
```

A run effect. Granted to `service_role` only and reached through the Company File control list, as
`qorpera_folder_agent_todos` is. In order:

1. **The request,** before any lock: exactly the four keys, a UUID, a tool name, a lower-case SHA-256, and 1 to 1000
   units (the commit's own bound). Anything else is 22023. The recorder does not parse the units: the commit decides
   every unit, and the digest binds them.
2. **The run entry:** `qorpera_folder_tool_run(p_binding, '[]')`. That is the binding, the stop, the run mutex, and
   `qorpera_folder_run_enter` with the company row at rank 0, `KEY SHARE`. A company that is not `folder-v2`, a stopped
   run or a paused company is refused there, replays included (the commit answers replays even then; a writer's
   replay comes from its receipt, §4).
3. **The approval:** the action review row by id, for this company and this run's agent, `FOR SHARE`. It must be an
   approval of this call that this run may act on:
   - its tool and argument digest are the request's, and the tool is one that writes folder change sets:
     `hire_agent`, `create_group_chat`, `manage_routine`, `decide_routine` or `company_delete`;
   - its effect is `delegation` or `destructive`, so an approved email never stands for folder units;
   - it is the run's own allow (`run_id` is this run and `decision = 'allow'`), or a card's allow this run used
     (`answer` is `allow_once` or `always_allow` and `consumed_run_id` is this run).

   Anything else is 42501, "This change has no approval in this run".
4. **The record:** the id is `md5('qorpera.folder-review:' || action review id)::uuid`, so one approval stands for one
   change set:
   - a row with that id, this run and the same digest: a replay, returned as it is;
   - a row with that id and another digest: 23505, "This approval was already used for another change";
   - else insert `(id, environment_id = the run's, run_id = this run, change_set_sha256 =
     qorpera_folder_change_set_sha256(units), units = 1..n)` with the decision below.
5. **The answer:** `{ schema: 'qorpera.folder-review/v1', reviewId, approvedBy, units: n }`.

The review covers every unit of the change set. The commit only consults it for units whose class is not plain, so
covering the plain ones changes nothing. Two approvals of the same change set are two records; either serves.

**Why no second layering.** The layering in SQL is `qorpera_record_action_review`, which has already run for this call.
A second pass over the same verdict could only repeat it. The recorder adds what the call's review cannot know: which
change set the approved call commits. This rests on one trust assumption, as all of v130 does: the runtime builds the
change set only from the reviewed call's arguments and its own reads, and labels effects truthfully. SQL narrows what a
wiring slip could do: the approval must be of this call (tool and argument digest) and of a folder-writing tool.

**Allow, deny and the card's member.**
- The run's own allow is recorded as `allow`.
- A card's allow is recorded as an answered ask: `decision = 'ask'`, `answer = 'allow'`, with the action review's
  `answered_by_user_id` and `answered_at`. The commit then records that member as the change's approver (C1B §5). This
  copies the answer when the row is made; it is not R2's answer path, so F1's 7b rule for answers is untouched. If the
  member has since been deleted (`on delete set null`), the record is a plain `allow`.
- No `deny` rows. A call the review denied, or one still waiting, never reaches `execute`, so no writer asks for a
  record. A change set without a record is denied by the commit (`review_required`), which is the deny. Rows with
  `deny`, open asks and answers given on folder reviews come with R2.

**Left out on purpose.** The recorder runs neither the wake gate nor the rank 10 recheck, which
`qorpera_folder_add_agent_review_rule` runs: the writer records inside its receipt, whose begin runs the wake gate, and
the commit runs rank 10. The record by itself changes nothing in the company.

## 3. Locks

| Order | Lock | Taken by |
| --- | --- | --- |
| run entry | binding, stop (plain read), run mutex (budget row `FOR UPDATE`), job and fence `KEY SHARE`, rank 0 company `KEY SHARE`, the run resolve's ranks (all `KEY SHARE`) | `qorpera_folder_tool_run` |
| after the run entry | the approval row (the action review; it may belong to the run that raised the card), `FOR SHARE` | the recorder |
| last | the folder clock row, `KEY SHARE`, through the new row's foreign key | the insert |

- The commit later takes the new row `FOR SHARE` at 7b, as C1B §6 says. A row that is not yet committed is invisible to
  it, and the writer commits only after the recorder answers.
- A used approval cannot change (it is consumed once, and an answer can be reset only while unused), so `FOR SHARE` is
  caution, not needed for correctness. It makes an answer in flight and the recorder's read take turns.
- The answer to a card (`qorpera_answer_action_review`) takes the member prelude, the conversation, then the action
  review `FOR UPDATE`, then the events, admission and the clock. So an answer and a recorder of the same approval wait
  for each other on that row, one at a time, never in a cycle: before the row, the recorder's locks are compatible
  with the prelude and it takes no conversation; after it, the recorder takes only the clock `KEY SHARE`, which the
  answer does not hold before the row. A recorder behind a first answer then finds the card answered but not used by
  its run, and refuses (42501).
- `qorpera_begin_action_review` in another run takes the same row `FOR UPDATE` after its own run entry, and needs
  nothing the recorder holds. The recorder enters as `begin` does and then takes that row in a weaker mode, so it closes
  no cycle that `begin` does not.
- A member's or another run's commit does not wait for a recorder at the clock: the folder clock is only ever updated
  (`FOR NO KEY UPDATE`), which is compatible with `KEY SHARE`. Like any tool call, a recorder still holds its run entry,
  so a commit that takes the run's wake room `FOR UPDATE` (a rename of the agent, for example) waits for it.
- Two recorders of one run never overlap: the run mutex orders them, and the second replays.
- No new company-wide lock, no new table or column, no cap of our own, no 40001 (test 361).

## 4. The runtime

- **The gate passes its approval on.** `CloudActionGateResult` becomes `{ run: true; reviewId?: string }`. The id is
  set on each approving path: the recorded allow (`cloud-action-review.ts`, record), a card approved while the call held
  on it (await), and a parked approval repeated (`begin` returns `approved`). The gate passes on only an id that is a
  UUID. The boundary puts it in the tool context as `actionReviewId`, beside the call's `argumentSha256`.
- **Staging is split from the commit.** `CloudCompanyFolderClient.stage(units)` stages the bytes and returns an opaque
  change set holding the units exactly as the commit sends them. `recordReview({ actionReviewId, tool, argumentSha256 },
  staged)` calls the recorder through its own call path: it sends `p_binding` (the client holds it), not the actor.
  `commitStaged(key, staged, { reviewId, receiptId })` commits the same units (each unit carries its own
  `expectedVersion`). `commit(key, units)` is unchanged: it stages, then commits. TypeScript never computes the digest:
  both RPCs send the same JSON, and SQL hashes its canonical text.
- The RPC joins `CloudCompanyPathRpc`, both control lists (`FOLDER_RPCS`, so SQL codes come through, and `permitted`)
  and the pinned test. A lost answer and a deadlock (40P01) are asked again with the same request, which replays; 23505
  and 42501 are answers. The client reports a 42501 as `unavailable`, the same as a run that ended; inside the receipt
  neither is the writer's to retry, so it need not tell them apart.
- **A writer with delegation units** (W4; §5):
  1. checks `completesFolderCommits`, pre-reads and refuses what can never be saved, outside the receipt (as W1–W3).
     Each such check must still pass once the call's own change is saved: a hire's "handle taken" check accepts the
     agent its own call created;
  2. without an `actionReviewId`, refuses: "This change needs the automatic review, which did not run";
  3. under its receipt (`requiresCompanyRevision`): stages, records the review, then `commitStaged` with `reviewId` and
     `receiptId`, and releases what it shows. It passes its own tool name: the tool context carries none.
- **Why inside the receipt.** A completed call replays its stored result from the receipt before anything is staged or
  recorded. A call does not record twice: a receipt that began without completing refuses a second run of the call
  (recovery review, `cloud-native-tool-operations.ts`), and in one process the call's cached promise is reused. The
  recorder runs again only through the client's own retry, with the same units, and replays. W4 still derives every
  generated id from the run and the call (as `releaseIdFor` does), so units never depend on when they were built.
- Any error after the receipt begins is an unknown outcome, as for the commit, and the begun receipt holds the run's
  other operations until it is resolved (20260928279540). So a writer refuses everything it can before the receipt.
  Staging, recording, the commit and the release share the tool call's one time limit.
- Staging is not a change to the company. Bytes staged for a call that never commits count against storage until
  their intents expire and are swept (C1d-2a); a full company can refuse at staging, as for any write.
- A conflict ends the call. A redo is a new call with a new review, so a member who approved a card may be asked again.

## 5. What uses it

- **W4** (one structured file type per PR, after R1): `hire_agent` (one `new_folder` unit with `agent.md` and the
  first todo), `create_group_chat` (`group.md`) and `manage_routine` (a routine file, after
  `qorpera_prepare_routine_login`). STATE-FILES §5 has their formats and reads. The commit round trip with a real hire
  (F2's agent hook) is tested in W4's PR. W4a (20260929940000) adds contract 14.1's restricted hire to the layering and
  to the recorder: an agent that cannot delegate the new agent's default access hires only on a member's answer.
- **`decide_routine`'s rewrite.** Today W3 refuses a decision that changes the title or the instructions on
  `folder-v2` ("needs a member's review", `cloud-folder-routine-decision.ts:165-171`), and reads a `denied` /
  `review_required` result as settled (:232-234). The gate already reviews such a call as delegation, and never raises a
  card for it, so an ask is refused. With R1, an allowed rewrite records its approval and saves; when a review was
  recorded, `review_required` becomes a defect, not "settled". This lands with W4's routine PR.
- **`company_delete`**, once it writes through the folder core: reviewed as destructive, it uses the recorder the same
  way. A `company_write` onto a delegation path is not reviewed by tool name, so it stays denied until R2. The model is
  told to use the tool made for the change.
- **Not reviewed here:** workers have no hiring or routine tools, and their asks are refused (no cards); coding
  sessions are never reviewed; a view never carries an R1 review id (R2). A `folder-v2` run always has a requester.
- **An approval stands as given.** As in v130, a card's answer stays valid when the call repeats in a later run, even
  if the member's role changed meanwhile. The commit still checks the run's own authority.

## 6. Tests

SQL test **769** (migration **20260929890000**), on 647's hand-built runs with their native rows (as 652), with files
staged on the version-2 path by the test's own helper (open, confirm, seal):
- **Approvals.** The run's own allow records, and its commit saves the deletion. A card's allow used by this run
  records, through the holding call's wait and through a woken run's begin, with its member as the commit's approver; a
  card whose member was deleted records a plain allow. Each of these is refused (42501): a card answered but not yet
  used by this run, a card used by another run, an unanswered ask, a denial, an answered denial, another run's allow,
  another agent's review, another company's row, an approved `external` action, a delegation by a tool that writes no
  folder change sets (`manage_worker`), another tool's name, another argument digest, and an unknown id. A
  `company_delete` approval records and saves.
- **One change set per approval.** The same digest replays the same row; another digest is 23505. Two approvals of one
  change set are two records, and either serves.
- **The commit.** Without a record the deletion is denied (`review_required`); with units changed after recording, or
  with another run's record, it is denied (`review_required`); with the record it saves and names it.
- **Bounds.** 0 or 1,001 units, a non-array, a missing or extra key, a bad id, tool or digest are 22023, even while the
  company is paused (the request is checked before the run entry).
- **The run entry.** A `snapshot-v1` company's run, a paused company and a company being deleted are refused, and the
  body checks the request, enters the run check, shares the approval and inserts, in that order.
- **Grants.** `anon` and `authenticated` cannot execute the recorder; `service_role` can. Security definer, empty
  search path.

SQL test **770**, races (dblink, on 648's committed fixture, as 653):
- another run's `begin` holding the approval row: the recorder waits at that row, then records;
- a recorder holding it: the other run's `begin` waits, then finishes;
- a member's commit beside a recorder in flight does not wait;
- the real answer (`qorpera_answer_action_review`): a first answer in flight holds the row and the recorder waits there,
  then refuses (answered, not used by this run); a retried answer and the recorder take turns at the row in both
  orders, and the recorder replays; a first answer to another card of the run, which wakes the agent, does not wait
  for a recorder;
- two recorders of one fresh approval of one run: the second waits at the run mutex, then replays.

Mutants of the recorder: 23 of 25 killed in my set, and 12 of 15 in the review's own set (rounds 2 and 3). Three
survivors, all equivalent: the agent filter (an approval row always names its run's agent), a denied answer among the accepted ones
(a used approval is always an allow, by the check constraint) and the run clause of the replay check (only this run can
reach a record of an approval it used). A read of the record before the run entry is killed by 770's race E.

Runtime:
- The gate returns the review id on each approving path, none from a malformed answer, and none on a read or an
  internal call.
- The boundary passes `actionReviewId` to `execute`, and none when the review passed no id.
- The folder client: `stage` stages once; `recordReview` and `commitStaged` send the same units; the recorder's request
  is the binding and the call's approval, nothing of the actor; a lost answer and a deadlock (40P01) are asked again
  with the same request; 23505, 22023 and 42501 are not retried; a malformed answer is refused; only a change set this
  client staged is recorded or committed.
- The control list's pinned test.

## 7. Release

- Feature PR, no bundle files. The cut's activation guard requires
  `to_regprocedure('public.qorpera_folder_record_review(jsonb,jsonb)')`. Before the cut, confirm it is absent live.
- The SQL and the runtime ship in one cut. The runtime calls the recorder only from a writer, and none does before W4,
  so the change is inert until then.

## 8. R2: change sets no tool call carried (not built)

An agent can also change delegation paths without a reviewed tool: a computer or shell edit saved through a view
(C1b-3), or a Company File write onto `agents/**`. Those units are denied today and stay denied after R1. R2 reviews the
change set itself:
- the reviewer runs on the change set, and SQL applies the same layering, factored out of `qorpera_record_action_review`
  so both share it;
- the record can be `ask` or `deny`; an ask raises a card on the change set;
- a member's answer takes the review row `FOR NO KEY UPDATE` at 7b, after the member prelude and before the
  conversation;
- a unit `waiting_for_review` is parked as a proposal (`qorpera_folder_proposals`, not built), and an allow applies it.

F1 decides who builds R2.
