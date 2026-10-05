# Hooks, mailboxes and event wakes on the folder core (C4, Q1)

Status: plan agreed 4 October 2026 (Q1, qorpera-cb, with the coordinator, F2 and A1; §10). **E1 built** (migration
`20260930060000`, SQL tests 912 and 919; the parser's two kinds; the writer by kind). **E2a built** (migration
`20260930061000`, SQL tests 913 and 923; §4 as built). E2b (scheduling, the parser, the runtime) follows.

## 0. Why

Agents waking on outside events was Jonas's first priority for "Qorpera on Qorpera" (29 September). Event intake (W1a,
W1b), event wakes (W2) and company mailboxes (M2a, M2b, M2c-1, I5a) were built and are live, but only for companies on
the old core. Every company is now on `folder-v2` (founder decision, 3 October), and on master each of these refuses a
`folder-v2` company:

- `qorpera_create_event_hook` and `qorpera_create_company_mailbox` raise 0A000 ("… come with their connection file",
  `20260928259260_runtime_event_intake.sql:222-228`, `20260928299650_runtime_company_mailboxes.sql:170-174`);
- the folder wake gate refuses `source_kind 'event'` (`20260928269290_runtime_event_wakes.sql:201-204`), routine files
  have no `when: event` (`packages/cloud-client/src/company-state-files.ts:86`), and the folder wake read has no event
  batch (`20260928279580_folder_core_run_wakes.sql:275-334`);
- W2's event drain uses the old admission fence, and nothing has called it since P28 removed the legacy materializers from
  reconcile.

So no new company can have a hook or a mailbox, and no routine can wake on one. This plan rebuilds them on the folder
core. The coordinator assigned it to Q1 on 4 October; company accounts (`20260928419970`) stay A1's, after P06d.

## 1. What already works for any company, unchanged

These read and write only intake, mail, vault and run tables, take no company lock, and work for `folder-v2` once a hook
row exists:

- the intake door `qorpera_receive_event` and the `event-intake` edge function;
- W1b's signed-hook verification in the vault (claim and finish);
- the mail door `qorpera_receive_mail` and the `mail-intake` edge function;
- `read_event`, `list_hooks`, `find_mail`, and `send_mail` without attachments. Their run check dispatches folder-v2 to
  `qorpera_folder_tool_run` (`20260928279470:5-7`);
- the outbox (`mail-outbox`), member mail reads (I5a), the purge, and the per-hook, per-company and platform limits.

Two exceptions stay refused on `folder-v2` until §7: attachments, both sending them (`ATT:366-376`, the legacy path
actor) and saving them (`ATT:155`).

## 2. The steps

| Step | What | Depends on |
|---|---|---|
| **E1** | Hooks and mailboxes on folder-v2: create, pause, remove, each with its connection file (§3) | P22 (merged), P22b writer |
| **E2** | Event wakes: `when: event` in routine files, the folder event drain, the wake gate and the wake read (§4) | E1, P29's shared folder drains (merged) |
| **E3** | Agents open hooks and mailboxes themselves (`manage_hook`, W3) (§5) | E1 |
| **E4** | Settings → Company connections lists hooks and mailboxes for owners and admins (§6) | E1 |
| later | Events and mail as files, attachments, a mailbox at founding (§7) | E1–E2 |

E1 and E2 are each one SQL PR, plus the TypeScript they need. E3 and E4 are small. E1 → E2 → E3 is the critical path for
the live test (§8), because an agent can then set up and use a hook with no member screen.

## 3. E1: hooks and mailboxes on folder-v2

### 3.1 Who holds what

The database stays the authority for a hook: its address (a 43-character capability), its proof, its limits, its status
and its delivery receipts. This is contract events amendment item 2 ("the database keeps the address, the limits and the
delivery receipts as runtime state").

The company folder describes each hook in a connection file. Like every connection file since P22, the platform's
writer converges that file shortly after the change commits; the hook's own transaction doesn't commit it ("the vault
never calls the commit", core §3, 3 October). So item 2's "the platform writes it in the same step as the hook" becomes
"the platform's writer brings it in line within seconds". The contract's wording is amended with E1.

Every tool that acts on a hook (intake, wakes, `list_hooks`, `send_mail`) reads the hook row, never the file.

### 3.2 The files (as built)

Two structured kinds, `hook` and `mailbox`, at `connections/hook-<name>.md` and `connections/mailbox-<name>.md`. The
format is in `RUNTIME-COMPANY-STATE-FILES.md` §2:
- hook settings: `id`, `name`, `proof`, `status`, `max_body_bytes`, `per_minute`, `created_by`, `created_at`;
- mailbox settings: `id`, `address`, `status`, `created_by`, `created_at`;
- the body is the company's, and a new file starts with the purpose given at creation.

- **What a file never holds:** the hook's address (a capability, shown only to owners and admins, as today), a signing
  secret, or anything from the vault.
- **The name:** the hook's name or the mailbox's local part, mapped to the folder's name rule and cut to fit 64
  characters with the prefix. On a clash the writer adds `-2`, `-3` …, as for accounts.
- **Removal:** a removed hook or mailbox has no file; the writer deletes it, as it does a revoked secret's.
- **Pausing:** a paused hook keeps its file with `status: paused`.
- **An agent's routine names a hook by `id`** (§4.1). The file is where agents find that id. Hook names are freed on
  removal, so a name could later point at a different hook; an id cannot.

### 3.3 The connection-file machinery gains hooks (as built)

E1 extends P22 rather than adding a second writer. A1, who owns P22, agreed on 4 October; F2 owns the writer (P22b).

- **The prefixes are kinds.** The path's kind is decided before a vault connection's (`qorpera_structured_path_kind`,
  `companyStatePath`).
  - A file at either prefix is a hook's or a mailbox's.
  - A move from one prefix to another is a kind change, which the folder refuses.
  - The vault's name derivation gives a natural name that starts with `hook-` or `mailbox-` a `connection-` prefix (test
    912).
  - This reserves the prefixes, as `RUNTIME-EVENT-INTAKE.md:96-99` promised.
- **A kind, not an overloaded id.**
  - P22's marks and work gain `subject_kind` (`vault`, `hook` or `mailbox`, default `vault`), and the work row's key is
    (kind, id).
  - The claim reads the state by kind: `qorpera_folder_connection_file_state(secret)` for the vault, and
    `qorpera_folder_hook_file_state(kind, id, environment)` for a hook or a mailbox. It never asks whether a vault secret
    has the id.
  - The claim answers `subjectKind`, and for a hook or a mailbox also `body`. Its operation key is
    `hook-file:<id>:<generation>` or `mailbox-file:<id>:<generation>`.
  - `qorpera_finish_connection_file` takes `p_subject_kind` (default `vault`).
  - P22a's invariants stay:
    - a mark is a plain insert that waits on nothing;
    - the claim creates work rows in (kind, id) order, locks only work rows, its marks and the companies it key-shares,
      SKIP LOCKED, and never touches a hook row;
    - P14a's creation guard is kept.
- **Marks:** triggers on `qorpera_event_hooks` mark a folder-v2 hook due on insert and on a change of `status`, `name`,
  `max_body_bytes` or `per_minute`. The kind follows `proof` (`mail` is a mailbox).
  - A mailbox's file shows its address, which carries the mail domain. A change of `qorpera_mail_settings.domain` marks
    every live folder-v2 mailbox (review r1 F2).
  - A mailbox's creation reads the domain `FOR SHARE`, after its other locks (§3.4). So a creation and a domain change
    never overlap unseen: the creation waits for an open domain change and its file shows the new address, or the domain
    change waits for an open creation and then marks it (review r2 F2).
- **The index:** `qorpera_folder_hook_index` (environment, id), its own table in the human-task index's style:
  - apply writes it, repoints it on a move and retires it on a delete;
  - verify checks it;
  - erasure deletes a retired row under its roots.
- **Rules:** `qorpera_company_state_hook_rules`, which require that:
  - the id is a hook of this company and environment, of the file's kind;
  - a file at a key keeps its id, and a hook has one file;
  - a member or an agent changes only the body, compared with the last parse the index trusts;
  - a platform write's settings equal the hook's state exactly;
  - only the platform deletes a file, and only once the hook is removed.
- **The writer** (`packages/object-gateway/src/connection-files.ts`) and the parser (`company-state-files.ts`) gain the
  two allow-lists and the two kinds.
  - The writer reads a claim from before E1's migration (no `subjectKind`) as a vault's, and finishes a vault's claim
    without naming a kind, so the gateway can roll first.
  - It stays behind `QORPERA_CONNECTION_FILE_WRITER`.

### 3.4 Creating, pausing and removing on folder-v2 (as built)

The old functions take the company row `FOR NO KEY UPDATE`, which the folder core forbids on folder-v2 (core §3: never
stronger than KEY SHARE). Each gets a folder-v2 branch in core §3's order; the snapshot-v1 path is unchanged:

1. the role check, as today;
2. `qorpera_folder_company_enter(env, profile, targets, false)`: the fence KEY SHARE, the company row KEY SHARE (rank 0),
   and the acting member KEY SHARE (rank 1). Creating a hook starts no work, so a paused company may still create one;
   then the deletion and role recheck;
3. **Pause and remove:** the hook row `FOR NO KEY UPDATE` at rank 5, through the same call. `qorpera_event_hooks` is last
   in `qorpera_folder_structured_lock`'s table order, where E2's routine saves take it `FOR SHARE`;
4. **Create only:** the advisory transaction lock `qorpera.event-hooks:<profile>`. It serializes the caps (50 live hooks,
   20 mailboxes) and the live names, which the company row lock used to. Only these functions take it. After it, a hook's
   creation waits on nothing. A mailbox's creation then reads the mail domain `FOR SHARE`, last, against a domain change.
   A domain change takes no lock that a creation holds;
5. the insert or update, and the mailbox row, as today. The file's mark comes from the trigger.

The rest is unchanged:
- grants (owners and admins, through `authenticated`), names, reserved names, the mail domain, the Qorpera-name refusal,
  limits and addresses;
- the `qorpera_folder_enable_internal` check that a company with live hooks can't *become* folder-v2.

### 3.5 Tests (E1, as built)

- **SQL test 912, on 852's fixture:**
  - **Creating:** creating a hook and a mailbox on folder-v2 holds the company's advisory lock and marks each by kind. A
    contributor is refused, as are taken names and addresses and the 50-hook cap.
  - **Claims:**
    - each claim's settings, path, body and operation key;
    - the hook's address in no claim;
    - the platform's writes indexed, and finish by kind.
  - **Rules:**
    - a member changes the body only, never a setting;
    - one file per hook;
    - the id is this company's hook of the file's kind;
    - the platform's settings match the hook;
    - only the platform deletes, once the hook is removed;
    - a rename within the prefix follows, and any other move is a kind change;
    - a vault website account at `hook-x.example.com` is named `connection-hook-x-example-com`.
  - **Pausing and removing:** a pause and a removal each mark the hook. The claim shows it paused, then absent; the
    platform's delete retires the row; a vault finish never closes a hook's claim.
  - **A new mail domain** marks the mailbox, and its claim shows the new address.
  - **Privileges:** the new functions are the platform's alone.
  - **Mutation-checked:** a member's setting change, and an address in the claim, each fail it.
- **SQL test 919 (dblink), on 648's committed fixture:**
  - R1: a removal waits for an open write of the hook's file at the hook row, and the next claim deletes the file;
  - R2: a write sent after the removal is refused;
  - R3: a mailbox's creation waits for an open domain change at the mail settings, and its claim shows the new domain.
  - Mutation-checked: without the rank-5 hook target, R1 fails; without the domain `FOR SHARE`, R3 fails.
- **Existing tests:**
  - 730 and 732 now expect a folder company's hook and mailbox to be created;
  - 852 names the finish's new signature;
  - 856 §7 keeps only P14a's guard of the rewritten claim (no pin of old text, founder decision 3 October).
- **TypeScript:**
  - the parser's two kinds, round trips and refusals;
  - the writer's claim parsing by kind, a new hook file's body, commits as `hook`, and finish with and without the kind.

## 4. E2: event wakes (F2-6b, the event drain, the gate and the read)

### 4.1 The routine file

```yaml
when: event
hook: 0b7c…          # the hook's id (lowercase uuid), from its connection file
only: [payment_intent.succeeded, charge.refunded]   # optional, 1–20 distinct event types
timezone: Europe/Copenhagen
reply: …
```

This is the spelling W2 and F2-6 agreed (`REG:1948`, `RUNTIME-COMPANY-STATE-FILES.md:393`).
- The parser adds `event` to `ROUTINE_WHEN` and `TRIGGER_KEYS.event = [hook, only]`.
- SQL's parse shape adds the same keys.
- The trigger compiler emits W2's trigger, `{kind:'listener', source:'event', id:'file', hookId, only?, timeZone,
  replyPolicy}`.
- W2's version-insert trigger (`qorpera_activate_company_file_listener`) then creates the event cursor, as it does for
  old-core routines.

### 4.2 Rules and locks

- **The routine rules** require `hook` to be a live hook of the same company and environment when the file is saved
  (as built: the problem is "hook … is not a hook or mailbox of this company; list_hooks shows them"). They also refuse
  a ChatGPT plan as payer, as P29's file-change routines do.
  - The rules run in decide, under the hook's lock (the commit's rank-5 target). A hook removed before the lock refuses
    the save, rather than saving a routine whose listener can never fire (F2, 4 October).
  - Moves and handovers don't ask the rules. On folder-v2, W2's version trigger no longer raises 42501 for a removed hook
    or a plan payer. Such a version gets a cursor that never wakes: the drain and the gate check the hook, and the gate
    refuses a plan-paid listener's wakes. Raising would have refused the whole change set.
- **The commit** takes each named hook row `FOR SHARE` at rank 5, through the structured-lock targets.
  - `qorpera_event_hooks` goes last in rank 5's table order, after routines and every other index table.
  - Every writer of a hook row takes it at that same place, after the routines it holds, and nothing after rank 5:
    E1's create, pause and remove; E3's tool; the event drain, also `FOR SHARE`. A `KEY SHARE` would not wait for a
    removal's `FOR NO KEY UPDATE`.
  - So a save and a removal serialize: either the save sees the hook removed, or the removal waits for the save. No
    trigger deactivates the cursors of a removed hook. The due list, the drain and the gate all skip a removed hook.
- **The compiled trigger** is byte-identical to the one W2 stores for old-core routines. So the cursor trigger, the event
  drain and the member mail reads (which join cursors) read one shape.

### 4.3 The event drain (`events`, on the shared folder drains)

The drain follows P29's contract (`RUNTIME-COMPANY-FOLDER-LISTENER.md` §9) and #803's shape.

- **The due list:** `qorpera_folder_event_wakes_due(p_after_environment, p_limit)` is a plain read. It lists the folder-v2
  environments that have an active event cursor with a verified delivery after the cursor's mark and no open event wake
  for that trigger. It leaves out companies being deleted and paused ones: paused events wait, as W2's drain skips paused
  companies (`WAKES:277`).
- **One company:** `qorpera_folder_event_wakes_company(p_environment_id, p_limit ≤ 64)`, in one transaction (as built):
  1. a plain read of the company's live listeners (least recently scanned first) and their routine, requester, agent and
     trigger;
  2. `qorpera_folder_company_enter(…, false)` with those targets: requesters at rank 1, agents at 2, authorities at 3,
     each routine `FOR NO KEY UPDATE` and its hook `FOR SHARE` at rank 5. Then `deleting`, or `paused` with nothing
     written or moved: a paused company's events wait;
  3. each cursor `FOR UPDATE SKIP LOCKED`, as run-owned rows after the ranks;
  4. W2's checks under the locks: the routine current and active, the hook live, the agent active, no wake pending, the
     first matching delivery (none: the cursor's mark moves past what `only` skips), the attempts and their waits, the
     public conversation for a `required` reply, and the requester still a member;
  5. the conversations KEY SHARE;
  6. `qorpera_folder_admit_wakes` only if a wake will be inserted;
  7. the inserts in subtransactions. Each is a wake occurrence with `source_kind 'event'`, `source_id` the hook id (the
     pin trigger sets it), and W2's occurrence key (`event:<version>:<trigger>:<first delivery>:<attempt>`) and payload
     (`hookId`, `firstDeliveryId`). The run's first read takes the deliveries (up to 20) and moves the mark, as W2's
     read does. A known refusal (expired, at its limit, a requester or audience gone) is passed over.

  It answers `busy` on 55P03/40P01 (or a conversation that moved at insert), and `paused`, `idle`, `deleting` or
  `not_folder` rather than raising. Its bounds are W2's: one open wake per trigger, at most 20 deliveries per wake, and
  retries after 1, 4, 16 and 64 minutes before a delivery is left behind.
- **Scheduling:** one `FOLDER_DRAINS` entry (`events`) in `runner-orchestrator.ts`, and one `CLOUD_FOLDER_DRAINS` entry
  after `listen`. Re-pin the Runner Orchestrator, shared execution and LXD provider artifacts. Deploy the migration, then
  the edge function, then the orchestrator.

### 4.4 The gate, the read, the runtime

- **The gate:** `qorpera_folder_wake_authorized` drops `event` from its refusal list and checks that the hook is still
  live, as W2's patch does on the old gate. As built, `'event'` leaves the list by its own token. That works whatever
  other kinds the list still holds (#803 and 3i-b drop theirs the same way), and the whole clause goes when nothing is
  left in it.
- **The read:** `qorpera_folder_read_wake` adds W2's event batch (`qorpera_event_wake_payload`). The runtime already
  parses the envelope (`packages/runtime/src/cloud-wake-bus.ts:403-450`).
- **The runtime:** `manage_routine` on folder-v2 accepts `event` and writes `when: event` into the routine file
  (`cloud-routine-tools.ts:530-533` keeps refusing `file_change` only if P29 hasn't lifted it by then).

### 4.5 Tests (E2)

E2 ships in two PRs:
- **E2a** (migration `20260930061000`, SQL tests 913 and 923) carries the SQL. The drain functions stay inert until
  scheduled.
- **E2b** carries the `events` drain entry and the re-pins, the parser and the runtime. It comes after #803 and #816
  have taken their drain slots and pins.

As built, 913 runs on 708's company (P29's 887 uses the same). It covers:
- the shape and W2's trigger, and the cursor;
- both rules (a removed or unknown hook, a ChatGPT plan payer) and the rank-5 target;
- one wake for a batch, with W2's key and payload, `only` filtering, and one open wake per trigger;
- the gate, and the run's read: the batch is the wake's, and a late delivery makes the next wake;
- a retry after its wait, a paused company's events waiting, a removed hook stopping, and the grants.

923 races a save against a removal, and the drain against a save.

The plan's original list:
- **SQL (on E1's fixture):**
  - a routine file with `when: event` indexes a cursor; a delivery to its hook makes one wake through the drain, and the
    run's read carries the batch;
  - `only` filters events; a burst is grouped into one wake;
  - a paused company gets no wake, then wakes after resume;
  - a removed hook stops the cursor; the gate refuses a wake whose hook was removed after it was queued;
  - `hook_unavailable` on save;
  - save and remove serialize (dblink).
- **Existing tests:** 708's event section and 656 move from refusal to these expectations.
- **TypeScript:** the parser; the drain tables in the edge function and the orchestrator; the runtime's
  `manage_routine`.

## 5. E3: agents open hooks and mailboxes (W3)

This builds `RUNTIME-EVENT-INTAKE.md:123-127` on folder-v2: an agent's `manage_hook` tool can create, pause and remove
hooks and mailboxes for its company.

- **Review:** a new hook or mailbox is reviewed as a new connection. Pausing and removing are not reviewed.
- **The address:** the agent receives it in the tool's result, so it can register the address with the service it
  connects (for example GitHub's webhook settings). The address stays in the run and never goes into a file.
- **Signed hooks:** signing secrets go to the vault through A1's fill path, never through the model.
  - Where the service lets the creator choose the secret (GitHub, HMAC), the vault generates it.
  - Where the service shows a secret (Stripe), the agent captures it on the Company Computer with the vault's fill.
- **Locks:** E1's functions, entered from the run (`qorpera_folder_run_enter`), in the same order.

E3 gets its own short design section before it is built; the review class and the secret capture are the parts to
agree on.

## 6. E4: hooks and mailboxes in Settings

Settings → Company connections lists hooks and mailboxes beside accounts, as `supabase/CLIENT-CONTRACT.md` already says
(step A3). Owners and admins can create, pause and remove them and see a hook's address. Every member sees a hook's name,
purpose and status. This is web only, on the existing RPCs (`qorpera_list_event_hooks`, `qorpera_create_event_hook`,
`qorpera_set_event_hook_status`, `qorpera_create_company_mailbox`). It is agreed with Interfaces, whose Mailbox page
reads the same mailboxes.

## 7. Later, not in E1–E4

- **Events and mail as files.** The sources disagree on where these go:
  - events: `hooks/<hook>/` (contract item 6) or `hooks/<hook name>/<yyyy-mm-dd>/<delivery id>.json`
    (`RUNTIME-EVENT-INTAKE.md:397-400`);
  - received mail: `hooks/<hook>/` (contract, interfaces) or `mail/<address>/` with sent mail beside it (M2c-2, interfaces
    decision 3).

  Folder path versions are kept for good, so every stored event would count against the company's storage. This needs
  its own decision, on paths, what is kept and its weight on the quota, before it is built. Until then, events and mail
  stay runtime rows (bodies 7 days, rows 30 days), read through `read_event`, `find_mail` and the member mail reads.
- **Attachments on folder-v2:** sending files from the folder and saving received ones into it, through the folder client
  rather than the legacy path actor.
- **N1:** a mailbox at founding (`<handle>@inbox.qorpera.com`), in the creation seed once mail is switched on.
- **Erasure:** mail rows to and from a contact join erasure's table before H4 sends to a contact
  (`RUNTIME-COMPANY-FOLDER-ERASURE.md:267`).

## 8. Live test

This needs no member screens.
- After E1 to E3, on Jonas's first folder-v2 company:
  1. the Co-Founder is asked to set up a webhook, and its routine;
  2. a signed or plain POST to the address from a node wakes the routine within one 2 s pass;
  3. the wake's `read_event` returns the body;
  4. the delivery receipt, the wake and the run show in the watch.
- **Mailboxes:** the same once Jonas's Resend and Cloudflare steps are done (`MAIL-JONAS.md` 2–5; 6 and 6b by the
  coordinator's script): an email to the mailbox wakes the routine, and the agent answers it.

## 9. Housekeeping with E1–E2

- **Contract events amendment:** item 2 ("in the same step") and item 6 ("in the same change set") reworded to the
  writer's convergence; item 6's folder copies point to §7.
- **`RUNTIME-EVENT-INTAKE.md`:**
  - the W1b slot (`:8-10`);
  - find_mail and attachments still "in review" (`:17-24`);
  - the "whichever lands second" lines (`:393-395`).
- **`RUNTIME-COMPANY-STATE-FILES.md`:** the hook and mailbox connection kinds in §2; `when: event` in the routine table.
- **`supabase/CLIENT-CONTRACT.md`:** the hook list in Settings, with E4.

## 10. Agreed on 4 October

1. **F2-6b:** Q1 builds all of it, and F2 (qorpera-04) reviews the state-file parts. It merges after #769 and #813, which
   also change `company-state-files.ts` and the routine rules.
2. **The kinds:** separate `connections/hook-<stem>.md` and `connections/mailbox-<stem>.md` (F2). Both are added to
   STATE-FILES §2's table and to `companyStatePath`'s kinds, so the folder-name rule refuses a member-made file in either
   shape.
3. **P22:** extended, not duplicated (A1). There is a kind discriminator, the invariants are kept, the prefixes are
   reserved with a collision test, and 852/853 run again unchanged. The writer's allow-lists are agreed with F2, who
   owns P22b.
4. **The writer flag:** `QORPERA_CONNECTION_FILE_WRITER` is off in production today. The coordinator switches it on with
   v172's gateway redeploy, and P22's account files and E1's hook and mailbox files appear from then on.
5. **The order:** E1 → E2 → E3 for the live test (the coordinator).
