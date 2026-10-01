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

Everything here runs only for `folder-v2` companies.

## 1. What already works

The automatic review (v130, RUNTIME-AUTO-REVIEW.md) runs before every acting tool call, `folder-v2` runs included:
- The tool boundary asks `CloudActionReviewGate` before `execute` (`cloud-native-tool-boundary.ts`). The gate classes
  the call by tool name (`cloudActionEffect`): `hire_agent` and `create_group_chat` are delegation, `manage_routine` is
  delegation except `list`, and `decide_routine` is delegation when it carries `intent` or `title`.
- `qorpera_begin_action_review`, `qorpera_record_action_review` and `qorpera_await_action_review` take the run check
  through `qorpera_native_tool_locked_run`, which on `folder-v2` is `qorpera_folder_tool_run` (20260928279470).
- `qorpera_record_action_review` is the kernel's layering, in SQL (20260926130000:339; delegation fix
  20260926210000:78-100):
  - an action the reviewer finds not asked for never runs on an allow;
  - an Ask first rule wins over an allow;
  - a built-in check (money, terms, deletion, access) asks unless a company Allow rule covers it; for delegation those
    checks never apply, so only an Ask first rule or the reviewer's own doubt asks;
  - a call denied earlier in the conversation asks again only after a member writes there.
- The rules are `qorpera_review_rules_for`: every company rule, which on `folder-v2` is the index of `rules/*.md`
  (F2-4, 20260928249190), plus the member's own rules. With no rule and no doubt, the call is allowed.
- An ask raises a card where the member it waits for can see it, and the call holds on it, then parks. The answer
  (`qorpera_answer_action_review`, on `folder-v2` behind the member prelude since 20260928319670) wakes the agent,
  whose repeated call is approved once (`consumed_run_id`). An ask where no card can be raised is refused
  (`APPROVAL_UNAVAILABLE_HERE`): "an ask becomes a deny where no card can be raised".
- A denial stands for its run and its conversation (`qorpera_begin_action_review`).

So the verdict on a W4 call is already the kernel's, layered in SQL with the `rules/` index, allow by default. What is
missing is the link from that verdict to the change set the call commits.

## 2. The recorder

```
qorpera_folder_record_review(p_binding jsonb, p_request jsonb) returns jsonb
p_request = { "actionReviewId": uuid, "units": [ ...the units exactly as the commit will send them... ] }
```

A run effect. Granted to `service_role` only and reached through the Company File control list, as
`qorpera_folder_agent_todos` is. In order:

1. **The run entry:** `qorpera_folder_tool_run(p_binding, '[]')`. That is the binding, the stop, the run mutex, and
   `qorpera_folder_run_enter` with the company row at rank 0, `KEY SHARE`. A company that is not `folder-v2`, a
   stopped run or a paused company is refused there.
2. **The run:** an agent's run (`staff_agent_id` set), as the action review requires.
3. **The request:** exactly the two keys. `units` is an array of 1 to 1000 items, the commit's own bound; anything
   else is 22023. The recorder does not parse the units: the commit decides every unit, and the digest binds them.
4. **The approval:** the action review row by id, for this company and this agent, `FOR SHARE`. It must be an
   approval this run may act on:
   - the run's own allow: `run_id` is this run and `decision = 'allow'`;
   - or an answered card used by this run: `answer` is `allow_once` or `always_allow` and `consumed_run_id` is this
     run.

   Its effect must be `delegation` or `destructive`, so an approved email can never stand for folder units. Anything
   else is 42501, "This change has no approval in this run".
5. **The record:** the id is `md5('qorpera.folder-review:' || action review id)::uuid`, so one approval stands for one
   change set:
   - a row with that id and the same digest: a replay, returned as it is;
   - a row with that id and another digest: 23505, "This approval was already used for another change";
   - else insert `(id, environment_id = the run's, run_id = this run, change_set_sha256 =
     qorpera_folder_change_set_sha256(units), units = 1..n, decision = 'allow')`.
6. **The answer:** `{ schema: 'qorpera.folder-review/v1', reviewId, decision: 'allow', units: n }`.

The review covers every unit of the change set. The commit only consults it for units whose class is not plain, so
covering the plain ones changes nothing.

**Why no second layering.** The layering in SQL is `qorpera_record_action_review`, which has already run for this call.
A second pass over the same verdict could only repeat it. The recorder adds what the call's review cannot know: which
change set the approved call commits.

**Why only `allow`.** A call the review denied, or one still waiting, never reaches `execute`, so no writer asks for a
record. A change set without a record is denied by the commit (`review_required`), which is the deny. Rows with
`ask` and `deny`, and answers on folder reviews, come with R2.

## 3. Locks

| Order | Lock | Taken by |
| --- | --- | --- |
| run entry | binding, stop (plain read), run mutex (budget row `FOR UPDATE`), job and fence `KEY SHARE`, rank 0 company `KEY SHARE`, the run resolve's ranks | `qorpera_folder_tool_run` |
| run-owned rows (after rank 9) | the action review, `FOR SHARE` | the recorder |
| last | the folder clock row, `KEY SHARE`, through the new row's foreign key | the insert |

- The commit later takes the new row `FOR SHARE` at 7b, as C1B §6 says. A row that is not yet committed is invisible to
  it, and the writer commits only after the recorder answers.
- The answer to a card (`qorpera_answer_action_review`) takes the member prelude, the conversation, then the action
  review `FOR UPDATE`. The recorder never locks a conversation, and the answer never waits for a lock the recorder
  holds (rank 0 `KEY SHARE` on both sides is compatible). So they never deadlock. The check constraint
  `consumed_at is null or answer in ('allow_once','always_allow')` means an approval used by this run cannot turn into
  a denial afterwards.
- `qorpera_begin_action_review` in another run takes the same action review `FOR UPDATE` and waits at most for one
  recorder. It holds no lock the recorder needs.
- Two recorders of one run never overlap: the run mutex orders them.
- No new company-wide lock, no new table or column, no cap of our own, no 40001 (test 361).

## 4. The runtime

- **The gate passes its approval on.** `CloudActionGateResult` becomes `{ run: true; reviewId?: string }`. The id is
  set on each approving path: the recorded allow, a card approved while the call held on it, and a parked approval
  repeated (`begin` returns `approved`). The boundary puts it in the tool context as `actionReviewId`.
- **Staging is split from the commit.** `CloudCompanyFolderClient.stage(units)` stages the bytes and returns the units
  exactly as the commit sends them. `recordReview(actionReviewId, staged)` calls the recorder. `commit` accepts a
  staged change set. TypeScript never computes the digest: both RPCs send the same JSON, and SQL hashes its canonical
  text.
- **A writer with delegation units** (W4; §5):
  1. checks `completesFolderCommits`, pre-reads and refuses what can never be saved (as W1–W3);
  2. without an `actionReviewId`, refuses: "This change needs the automatic review, which did not run";
  3. stages, then records the review. Any failure here is a `CloudToolRefusal`: nothing in the company changed, and a
     record no commit uses is inert;
  4. saves under its receipt with `reviewId`, `receiptId` and `expectedVersion`, and releases what it shows.
- A retry of the commit sends the same staged units and review id. A lost recorder answer is retried with the same
  request and replays.
- The RPC joins `CloudCompanyPathRpc` and the control list, and the list's pinned test.

## 5. What uses it

- **W4** (one structured file type per PR, after R1): `hire_agent` (one `new_folder` unit with `agent.md` and the
  first todo), `create_group_chat` (`group.md`) and `manage_routine` (a routine file, after
  `qorpera_prepare_routine_login`). STATE-FILES §5 has their formats and reads.
- **`decide_routine`'s rewrite.** Today W3 refuses a decision that changes the title or the instructions on
  `folder-v2` ("needs a member's review"). The gate already reviews such a call as delegation, and never raises a card
  for it, so an ask is refused. With R1, an allowed rewrite records its approval and saves. This lands with W4's
  routine PR.
- **The Company File tools** (`company_write`, `company_delete`), once they write through the folder core. A
  `company_delete` is reviewed as destructive and can use the recorder the same way. A `company_write` onto a
  delegation path is not reviewed by tool name, so it stays denied until R2. The model is told to use the tool made for
  the change.

## 6. Tests

SQL test **769** (migration **20260929890000**), on 647's hand-built runs with their native rows (as 652), with
files staged on the version-2 path (766's `pg_temp.stage`):
- **Approvals.** The run's own allow records. An answered card used by this run records. Each of these is refused
  (42501): a card used by another run, an unanswered ask, a denial, an answered denial, another run's allow, another
  agent's review, another company's review, and an approved `external` action.
- **One change set per approval.** The same digest replays the same row. Another digest is 23505.
- **Bounds.** 0 or 1,001 units, a non-array, and an extra key are 22023.
- **The commit.** A hire (`new_folder` with `agent.md`) saves with the recorded review. Without one it is denied
  (`review_required`). With units changed after recording, or with another run's review, it is denied
  (`review_required`). A review row whose decision is `deny` still gives `review_denied`, as 632 checks today.
- **The run entry.** A `snapshot-v1` company, a stopped run, a paused company and a run without an agent are refused.
- **Races (dblink, on 648's committed fixture, as 653).** A recorder waits for an answer in flight on the same action review,
  and the answer does not wait for the recorder. A recorder and a commit of another change set do not block each
  other.
- **Grants.** `anon` and `authenticated` cannot execute the recorder; `service_role` can.

Runtime:
- The gate returns the review id on each approving path, and none on a read or an internal call.
- The boundary passes `actionReviewId` to `execute`.
- The folder client: `stage`, `recordReview` and `commit` send the same units; a refused recording is a
  `CloudToolRefusal`.
- The control list's pinned test.

## 7. Release

- Feature PR, no bundle files. The guard for the cut: `to_regprocedure('public.qorpera_folder_record_review(jsonb,jsonb)')`
  is absent live before it.
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
