# Hooks, mailboxes and event wakes on the folder core (C4, Q1)

Status: plan agreed 4 October 2026 (Q1, qorpera-cb, with the coordinator, F2 and A1; §10). **E1 built** (migration
`20260930060000`, SQL tests 912 and 919; the parser's two kinds; the writer by kind). **E2a built** (migration
`20260930061000`, SQL tests 913 and 923; §4 as built). **E2b built** (the parser and writer, `manage_routine`'s event
trigger, the `events` drain entry; §4.1, §4.3, §4.4 as built).

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
| **E3** | Agents open hooks and mailboxes themselves (`manage_hook`, W3): E3a address hooks and mailboxes, E3b and E3c signed hooks (§5) | E1 |
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
- The parser adds `event` to `ROUTINE_WHEN` and `TRIGGER_KEYS.event = [hook, only]` (as built in E2b). `hook` is a
  lowercase id; `only`, when given, is a list of 1 to 20 distinct event types, each printable ASCII without spaces and
  at most 128 characters. The parse is `{when: event, hook, only}`, `only` null when absent. The writer quotes a type
  that YAML would read otherwise.
- SQL's parse shape adds the same keys (E2a).
- `cloudRoutineTriggerOfFile` reads an event routine as W2's listener, as the index compiles it, and
  `routineFileSettings` keeps `hook` and `only` through a member's edit of the title or the reply (E2b).
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
  environments whose step would wake a listener now (as built, after review r1):
  - a live listener: the routine's current version active, a valid trigger, its cursor active, its hook not removed, its
    agent active and its requester a member;
  - a verified delivery of a type it takes waiting (W2's `qorpera_event_listener_waiting`, with `only`);
  - no wake pending for its trigger, and no retry waiting for that delivery (`qorpera_folder_event_wake_retry_waits`).

  It leaves out companies being deleted and paused ones: paused events wait, as W2's drain skips paused companies
  (`WAKES:277`). A company is still listed when a `required` reply has no public conversation; its step passes it over.
- **One company:** `qorpera_folder_event_wakes_company(p_environment_id, p_limit ≤ 64)`, in one transaction (as built):
  1. a plain read of the company's live listeners (least recently scanned first) and their routine, requester, agent and
     trigger. Only live listeners (the routine current and active, a valid trigger, the hook not removed) are ordered and
     counted against `p_limit`, so an active cursor that is no listener never takes a live one's place (review r1 F1);
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
- **Scheduling (E2b, as built):** one `FOLDER_DRAINS` entry (`events`, at most 64 a company step) in the edge function's
  `runner-orchestrator.ts`, and one `CLOUD_FOLDER_DRAINS` entry after `coding_checkins` (16 a step, as
  `qorpera_drain_event_wakes` took them). Re-pin the Runner Orchestrator, shared execution and LXD provider artifacts.
  Deploy the migration, then the edge function, then the orchestrator, then the runtime bundle, the object gateway and
  the web client: an edge function without the entry answers 400, which pauses that drain alone, and agents are offered
  event routines only once the drain runs. The object gateway and the web client bundle the same parser (a member's
  commit, `memberFolderStructured`; the web's routine list). Until the gateway is redeployed, a member's edit of an event
  routine's file is refused as `structured_invalid`, and nothing is lost.

### 4.4 The gate, the read, the runtime

- **The gate:** `qorpera_folder_wake_authorized` drops `event` from its refusal list and checks that the hook is still
  live, as W2's patch does on the old gate. As built, `'event'` leaves the list by its own token. That works whatever
  other kinds the list still holds (#803 and 3i-b drop theirs the same way).
  - When nothing is left, the clause goes and a comment line of E2a's takes its place.
  - The rest of the statement (`then return false; end if;`) stays on a line of its own, because the line before the
    clause may be #803's comment. Removing the clause with its line break used to put that rest inside #803's comment.
    This was found by applying all three together.
- **The read:** `qorpera_folder_read_wake` adds W2's event batch (`qorpera_event_wake_payload`). The runtime already
  parses the envelope (`packages/runtime/src/cloud-wake-bus.ts:403-450`).
- **The runtime (E2b, as built):** `manage_routine` on folder-v2 offers and takes `event` (hookId, optional only,
  timeZone, report) and writes `when: event` into the routine's file; the save's own rules check the hook and the payer.
  Its folder-v2 description now names hooks and mailboxes from `list_hooks`, and says that a file_change or event
  routine listens from its last save, so a later save drops what was not delivered yet. The rest of its folder-v2
  wording is shorter, so it stays within the tool boundary's 4096 bytes (4023 as built).

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
- a retry after its wait, a paused company's events waiting, a removed hook stopping, and the grants;
- the due list: not due for a type the routine does not take, with a wake open, or while a retry waits;
- a step with `p_limit` 1 whose oldest active cursor is on a removed hook: the live listener still wakes (review r1 F1).

923 races a save against a removal, and the drain against a save.

E2b's TypeScript tests: the parser (an event routine read and written back, with quoting; a missing or uppercase hook,
an empty, scalar, repeated, spaced or 21-long `only`, and another trigger's keys); `cloudRoutineTriggerOfFile` and
`routineFileSettings`; `manage_routine` on folder-v2 (its schema, its description, an event upsert's file); and both
drain tables.

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

- **Review:** a new hook or mailbox is reviewed as a new connection. Pausing and resuming are not reviewed; removing is
  (§5.3).
- **The address:** the agent receives it in the tool's result, so it can register the address with the service it
  connects (for example GitHub's webhook settings). The address stays in the run and never goes into a file.
- **Signed hooks:** signing secrets go to the vault through A1's fill path, never through the model.
  - Where the service lets the creator choose the secret (GitHub, HMAC), the vault generates it.
  - Where the service shows a secret (Stripe), the agent captures it on the Company Computer with the vault's fill.
- **Locks:** E1's functions, entered from the run (`qorpera_folder_run_enter`), in the same order.

E3 comes in three parts: **E3a** address hooks and mailboxes (migration `20260930106000`, SQL test 939), **E3b** GitHub
and HMAC hooks with a secret the vault makes (§5.7), and **E3c** Stripe's secret taken from the screen (§5.8; E3c-1, the
database, is built; E3c-2 to E3c-4 come next). The coordinator agreed the design below on 6 October, with one change: no
member pastes a Stripe secret in Settings (§5.5).

### 5.1 The tool

`manage_hook` is offered on folder-v2 beside `list_hooks`, `read_event`, `find_mail` and `send_mail`:
- `create` with `kind: hook` (`name`, `purpose`, and optionally `maxBodyBytes` and `perMinute`), or with
  `kind: mailbox` (`localPart`, `purpose`);
- `pause`, `resume` and `remove` with `hook`: a name `list_hooks` shows (a mailbox's hook is its `mail-…` name);
- `operationKey` on every action: one change per key, and a retry with the same key gets the first answer.

The answer is the hook as `list_hooks` shows it. A create's answer also carries the hook's address and URL, or the
mailbox's email address, so the agent can give it to the service. The address is only in that answer, never in a file:
E1's connection file has none.

### 5.2 Who may

- **The run's requester is an owner or admin**, as for E1's Settings calls, and as `list_hooks` shows addresses only to
  such a run (`20260928269290:555-575`). The agent acts with its requester's authority, never more. Any other run is
  refused: 42501 "Only owners and admins can open hooks; ask one of them".
- Any agent of the company may, in any run such a member requested: a chat, a routine, an event wake.
- **A run that a hook's event woke may pause that hook, never remove it** (after E3a's review r2). E2a's gate refuses a
  run once its wake's hook is removed, and the receipt's completion checks the run again, so the removal would roll
  back. It is refused first: 55000 "A run this hook woke cannot remove it; pause it instead". Any other run, a chat for
  example, may remove it.
- The hook records the agent (`created_by_staff_agent_id`, which E1's file already shows as `createdBy`).
- E1's checks are unchanged: the name and purpose rules, at most 50 hooks and 20 mailboxes, a mailbox needs the mail
  domain, and the reserved mailbox names.

### 5.3 Review (agreed)

- **`create` is an outside effect (`external`)** and is reviewed like one. The card says "Open a hook" or "Open a
  mailbox", with the hook's name or the mailbox's local part (the part before the @) and the purpose. The reviewer's
  steps apply unchanged:
  - a hook that only an email or a web page asks for is denied (`not_requested`);
  - an Ask first rule that covers it (for example "ask before connecting new services") makes it ask;
  - otherwise it is allowed.
- **No new built-in check.** A "new connection" check would ask the member about every hook, a default gate no member
  chose. Members add rules when they want one.
- **`pause` and `resume` are `internal`** and not reviewed: they only narrow, or restore, what is already open.
- **`remove` is `destructive`** and reviewed (changed after E3a's review r1). A removal is final, it can remove what a
  member opened in Settings, and a removed mailbox's address is free for any company on the shared mail domain. A
  removal the member asked for is allowed; one that only an email or a web page asks for is denied (`not_requested`).

### 5.4 Locks (E3a)

One function, `qorpera_folder_manage_hook(p_binding, p_request)`. It is granted to the service role and host-dispatched
with the binding's scope, as `qorpera_folder_cancel_agent_worker` is:
1. The run check, `qorpera_folder_tool_run`. Its entry already holds the company row (rank 0) and the requester's
   member row (rank 1) KEY SHARE. A pause, resume or remove adds the hook row at rank 5 FOR NO KEY UPDATE, as E1's
   status change does.
2. The role check, under those locks.
3. The run receipt (`qorpera_folder_begin_run_receipt`, key `hook:<operationKey>`); a replay answers from it.
4. A create takes E1's per-company claim `qorpera.event-hooks:<profile>` (rank 9). A mailbox then takes the mail domain
   FOR SHARE, last, as in E1.
5. The caps, the name, then the insert or the status change; then the receipt completes.

The connection file follows the commit, through E1's marks. The receipt keeps the hook without its address, which is
read from the hook row for each answer.

### 5.5 Signed hooks (E3b and E3c, agreed)

E3a refused any `proof` but `address`: "A signed hook comes later; use an address hook for now". Since E3b-1 (§5.7) the
host's path refuses a signed proof with "A signed hook is opened through the vault" (0A000). Since E3c-1 (§5.8) that
includes Stripe, which until then had its own words ("A Stripe hook comes later: its secret is taken from Stripe's
screen").
- **GitHub and HMAC (E3b).** The secret broker makes the secret (32 random bytes). It seals it under the company's vault
  key and creates the hook with its `event_hook` secret (`h<hook id>`, field `signing_secret`) in one transaction, as A1's
  account opening makes a password (`cloud-company-account-vault.ts` `#open`). The agent types it into the service's
  form with the Company Computer's `vault_fill`, which gains a hook source: the hook's `signing_secret`, resealed to the
  computer's boot key as an account's password is. The model never sees it.
- **Stripe (E3c, §5.8).** Stripe makes the secret. Its endpoint page shows it behind **Reveal**, as often as anyone
  asks, and **Roll** replaces it. Moving the secret from that page into the vault needs a new Company Computer action,
  the fill's reverse (`vault_capture`, §5.8). Until E3c-2 and E3c-3 land, `manage_hook` refuses a Stripe hook with a
  plain reason. Members never copy a token by hand (Jonas, 23 September), so Settings offers no paste box for it.

### 5.6 Tests (E3a)

- **SQL 939, on E1's fixture:**
  - a hook and a mailbox created from an owner's run, with `created_by_staff_agent_id` and the file mark;
  - a run a plain member requested is refused;
  - the caps, the names, a missing mail domain, and a signed proof refused;
  - a replay with the same key gives the same hook; the same key for other work is refused;
  - pause, resume and remove, and a removed hook refused;
  - the address in the answer and never in the receipt;
  - the host call row and the grants.
- **SQL 985, on E2's fixture (913):** a run that a hook's event woke may pause and resume that hook but not remove it,
  and may remove another hook.
- **TypeScript:** the tool's schema and its description (under 4096 bytes), the effect classes and the card, the
  allow-lists, and the folder client's answer checks.
- **Deferred (needs Codex):** the live test (§8), where the Co-Founder sets up a hook.

### 5.7 E3b: GitHub and HMAC hooks (agreed 6 October)

E3b comes in three PRs: **E3b-1** the database (migration `20260930160000`, SQL test 987), **E3b-2** the broker's route
and the runtime's tool, **E3b-3** the computer's `vault_fill` of a hook's secret. The coordinator agreed the design on
6 October, with one addition to the fill (E3b-3, below).

**The request.** `manage_hook`'s `create` takes `proof` (`github` or `hmac-sha256`) and `site`, the host the secret may
be typed into: optional for GitHub (`github.com`), required for HMAC, refused on an address hook. A site is a lowercase
host name, as A1's account sites are ("A site is a host name such as github.com"). The hook keeps it in
`qorpera_event_hooks.secret_site` (null for address hooks, mailboxes and hooks a member made in Settings), and it is part
of the receipt's digest, so the same key for another site is other work.

**E3b-1, the database (as built).** E3a's function becomes `qorpera_folder_manage_hook_effect(p_binding, p_request,
p_vault, …)`, granted to no role, with E3a's order and checks word for word. It has two callers (E3c-1 adds a third, the
broker's Stripe opening, §5.8):
- `qorpera_folder_manage_hook`, the host's (name, signature and grants unchanged), passes no vault. A signed proof is
  refused there (0A000), because the runtime sends signed creates to the broker.
- `qorpera_folder_open_signed_hook`, the broker's, passes the vault. In the hook's own step it inserts the hook's
  `event_hook` secret (W1b's name `h<hook id>`, the company's, created by the run's requester), version 1 (the broker's
  envelope under this authority's key) and an audit row `hook_secret_made` with the run and the receipt. A replay answers
  from the receipt and stores nothing. A signed create's answer adds `secretSite`; a pause, resume or removal of a signed
  hook answers as E3a's do. The vault opens only a signed create: an address hook, a mailbox or a status
  change is refused (22023).

`qorpera_folder_describe_signed_hook` runs the same checks and returns what the envelope's associated data needs (the
company, the environment and the authority's key). `qorpera_fill_event_hook_secret` is A1's fill read for a hook's secret
(`{action: vault_fill, role: textbox, name, hook, field: signing_secret}`). It needs:
- the executing `computer_browser` receipt of exactly that call (the call's SHA-256 is the receipt's input);
- the computer the run's screen lease holds, and its current boot's fill key;
- a live signed hook of the run's company, with a site, whose secret is active and sealed for this authority's key;
- a requester who is an owner or admin.

It writes `hook_secret_used`. A paused hook's secret is still typed; a removed hook's is not, and W1b's trigger
(`qorpera_event_hooks_revoke_signing_secret`) revokes it.
It is not gated by A1's switch (that one is the accounts'), and A1's fill refuses a hook's call as no such account.
Since E3c-1 it refuses a Stripe hook as it does an address hook (0A000 "This hook has no secret the vault types"): the
vault takes a Stripe secret from Stripe's page and never types it (§5.8).

**Who may, and the locks.** The three broker functions are granted to `qorpera_secret_broker` only, and run A1's checks
before any lock: the broker's session and capability, a job of the authority's company, and folder-v2 only ("Hooks need
a company on the company folder"). The effect checks the envelope (the broker's id, the authority's key, 1 byte to
128 KiB with its digest) before E3a's run check (§5.4), and the run's company and environment after it. The opening
keeps E3a's order: the receipt, the company's hook claim (rank 9), the caps and the name, then the inserts. The fill holds the hook
(rank 5, FOR SHARE) through the run check, then its secret FOR SHARE, then the receipt FOR UPDATE.

**E3b-2, the broker and the runtime (as built).** The runtime sends a signed `create` to the broker's route instead of the
host's:
- **`manage_hook`** (`cloud-event-tools.ts`) takes `proof` `github` or `hmac-sha256` and `site` (a lowercase host name;
  `github.com` for GitHub unless named, required for HMAC, refused on an address hook). Stripe is still refused, with
  its reason, until E3c-2 (§5.8). The review card names who signs, the site, and that the vault makes a secret nobody
  sees.
- **The folder client** (`cloud-company-folder-client.ts`) sends a signed create to the company's secret broker
  (`POST /v1/event-hooks`, the runtime's token and the run's lease in `x-qorpera-identity` as on G2-6a's other broker
  routes, 15 s inside the client's 20 s), with the release retry and the same operation key. A host without the broker
  refuses it as unavailable and sends nothing. The answer must name the site the request named and carry the hook's
  `signingSecret` marker (`event_hook`, W1b's name, ready); the database's refusals come back in the model's words, and
  any other failure is a lost answer that the same key asks again.
- **The broker's route** (`cloud-secret-broker-http.ts`) first proves the request's binding with that lease (G2-6a,
  `RUNTIME-NATIVE-HOST-KEY.md`): a refusal is a plain 403, and the database is asked nothing else.
- **The broker** (`cloud-event-hook-vault.ts`) then describes the opening (the run's company, environment and key),
  draws a random secret id and 32 random bytes in the form the sender's verification reads (GitHub: hex; HMAC: `whsec_`
  and base64), seals them under the company's key with that id as associated data, and opens the hook in one call. The
  envelope and the bytes are zeroed after. Its answer is the hook's receipt or the database's refusal (by SQLSTATE,
  message at most 512 characters); anything else is "outcome unconfirmed". A retry's new id and envelope are never
  stored: the receipt answers.
- **Rollout:** after E3b-1's migration, the secret broker (it serves `/v1/event-hooks`), then the vault's nginx on node 1
  (the `:10000` server block in `RUNTIME-STEP-7-CLOUD-CONNECTORS.md`, which `QORPERA_CLOUD_SECRET_BROKER_URL` names):
  `location = /v1/event-hooks` (POST only), proxied through `$qorpera_operations_broker` as `/v1/company-accounts` is
  (the client sends `?company=<profileId>`), checked with `nginx -t` before the reload; then the runtime bundle. Until
  both are in place a signed create gets an error status, which the folder client takes as a lost answer: it asks again
  with the same key, then reports the outcome as unknown, and nothing is written.
The model never sees the secret.

**E3b-3, the fill (as built).** The Company Computer's `vault_fill` gains the hook source: the broker reads the hook's
`signing_secret` through `qorpera_fill_event_hook_secret`, reseals it to the computer's boot key, and the guest types it
into the named text box on the hook's site. The guest first makes the text box a password box, then reads the box's type
back and refuses the fill unless it is `password`, so a page that undoes the change never shows the secret (the
coordinator's addition). It is runtime and guest only: E3b-1's migration already has the read.
- **The tool** (`cloud-company-computer-tools.ts`): `computer_browser` takes `{action: vault_fill, role: textbox, name,
  hook, field: signing_secret}` beside the account's form; `hook` is the hook's id (list_hooks shows it), and no call
  names both a hook and an account. `manage_hook`'s description says how to put the secret into the sender's settings,
  and the review card reads "Type a hook's signing secret into a web page" and names the hook and the field.
- **The host** (`cloud-company-computer-native-client.ts`) sends a hook's call to the vault's hook route instead of the
  accounts' route, with the same binding, receipt, key and envelope. A host without the vault refuses it before the
  office ("Signed hooks are not set up for this company's computers", 0A000), as it does an account's.
- **The broker's route** (`POST /v1/event-hook-fills`, `cloud-secret-broker-http.ts`) proves the binding with the run's
  lease first (G2-6a), as `/v1/event-hooks` does, then asks the database in 15 s. Its request is
  `qorpera.event-hook-fill-request/v1` (the binding, the receipt, the call's key and its envelope), and its answer is
  `qorpera.event-hook-fill-answer/v1` (the box) or E3b-2's refusal by SQLSTATE. A1's answer schema is not reused,
  because A1's client takes only A1's SQLSTATEs.
- **The broker** (`cloud-event-hook-vault.ts`) checks the database's context field by field (its schema, the field
  `signing_secret`, the proof, the site, the authority's key, the envelope's base64 and SHA-256, and that it answers this
  call's receipt), opens the envelope with E3b-2's associated data, and seals `{value, hosts: [site]}` to the computer's
  fill key with A1-3's box. The box's associated data names the hook and `signing_secret` where an account's names the
  account and its field, so a hook's box never opens as an account's, nor one account's as a hook's. The envelope and
  the secret are zeroed after. Anything but a box or a refusal is "outcome unconfirmed".
- **The guest** (`cloud-company-computer-guest.ts`, `cloud-company-computer-account-fill.ts`) opens the box with the
  call's own hook and field, so a box for another hook or field does not open, and types only on the hook's site over
  https, in the page's own document. The box must be an `input` of type `text` or `password`. It becomes a password
  box and is marked private before the value arrives; its type is read back in a call of its own (after the page's
  scripts had their turn) and again just before the value goes in, and a box that is not `password` either time is
  refused (`ACCOUNT_FILL_NOT_HIDDEN`, nothing typed). A box that shows its text again after the typing is emptied and
  refused the same way. The secret stays hidden from every snapshot, title and address for the screen's lifetime, as a
  password does.
- **Rollout:** the secret broker (it serves `/v1/event-hook-fills`), then the vault's nginx on node 1, in the same
  `:10000` server block as E3b-2's line: `location = /v1/event-hook-fills` (POST only), proxied through
  `$qorpera_operations_broker` as `/v1/event-hooks` is, checked with `nginx -t` before the reload; then the runtime bundle
  and the office image (the guest's new identity and the password box). Until the route is in place a hook's fill gets an
  error status and nothing is typed; an office image without E3b-3 refuses a hook's call, and nothing is typed either.

**Tests (E3b-1): SQL 987, on 924's fixture**, with the company's broker authority and its computer:
- before the wake's acknowledgement, the broker's calls are refused and write nothing;
- the broker opens a GitHub hook (the hook, its secret, version 1 and the audit row, in one step: one receipt and one
  file mark) and an HMAC hook with a site and limits; a replay answers from the receipt and stores nothing; the same key
  for another site is refused; the host opens an address hook with no secret;
- every refusal writes nothing: Stripe, the site's rules, the vault opening anything but a signed create, the envelope,
  a taken secret id or name, the broker's authority and capability, another company's broker, a company not on the
  company folder, a signed proof on the host's path, Postgres' own session, and a requester who is no longer an owner;
- the fill: its exact answer; a finished receipt, another call's receipt, input or downstream key; the call's shape; an
  address hook, no such hook, another company's hook; another computer generation or screen; a version under another key;
  A1's fill refusing a hook's call; a removed hook (its secret revoked) and a revoked secret; a paused hook's fill;
- the browser action's hook variant, the grants, the marker, and the functions' order of checks and locks.
- **SQL 939** keeps E3a's checks, with the host's new refusals of a signed proof.

**Tests (E3b-2): SQL 948, on 987's fixture committed**, from two connections as the broker's login and an owner (the
harness of 861), with a second leased run (Bob's):
- the same opening twice at once (the runtime's retry): the second waits for the run, then answers the first's receipt
  word for word, and its secret id and envelope are never stored;
- two runs open hooks of the same name: the second waits for the company's hook claim and is refused (23505), writing
  nothing (no hook, secret or receipt); when the first rolls back, the second opens it;
- a fill holds the hook while the owner removes it: the removal waits, then revokes the secret the fill read (audit:
  made, used, revoked); a fill holds the secret while the owner revokes it: the revoke waits, then revokes it;
- a revoke holds the secret: the fill waits, then is refused ("gone from the vault") and writes no use; a removal holds
  the hook: the fill waits, then is refused ("removed").

The runtime's tests: `cloud-event-hook-vault` (the request and answer schemas, the secret's two forms, the sealed
associated data, the refusals by SQLSTATE, the zeroed buffers, an unknown key or a malformed context), the route and its
client, `cloud-company-folder-client` (the broker path, its checks of the answer, a host without the broker),
`cloud-event-tools` (the new fields and refusals) and `cloud-action-review` (the card).

**Tests (E3b-3):** runtime only, no SQL. `cloud-event-hook-vault` (the fill: the box opens only with the hook's identity
and only on the site; a refusal passes through; another receipt, a malformed context, a wrong digest or a missing
secret is unconfirmed, with the envelope zeroed; the database call's text and values; the route's proof, holder and
token), `cloud-company-account-fill-box` (a hook's box and an account's never open as each other), the guest's typing
(a text box becomes a password box; a page that keeps it a text box, or shows it again before or after the typing, is
refused, and in the last case the box is emptied; other boxes are refused), `cloud-company-computer-tools` (the hook form
and its refusals), `cloud-company-computer-native` (the hook route and a host without it) and `cloud-action-review`.

### 5.8 E3c: Stripe hooks, the secret taken from Stripe's screen (agreed 9 October)

E3c comes in four PRs: **E3c-1** the database (migration `20260930344000`, SQL test 419), **E3c-2** the broker and the
runtime, **E3c-3** the office image, and **E3c-4** the hold (migration `20260930345000`, SQL test 420). The coordinator
agreed the design on 9 October. E3c-1 is built (below). E3c-2, E3c-3 and E3c-4 ship together in one release; until then
`manage_hook` refuses a Stripe hook (§5.7, E3b-2).

**What it is for.** An agent opens a Stripe hook with `manage_hook`, adds its URL as an endpoint in Stripe, and then
moves the endpoint's signing secret (`whsec_…`) from Stripe's page into the vault with `vault_capture`. The model never
sees the value, no member copies it, and the hook takes deliveries from its first capture on. Until then intake answers
Stripe's deliveries 409 (`not_ready`, `event-intake.ts:117`), and Stripe keeps retrying them (up to 3 days in live
mode), so nothing is lost while the hook waits.

**1. Opening a Stripe hook.**
- `manage_hook`'s `create` takes `proof: stripe`. The site is fixed to `dashboard.stripe.com`, the page the secret is
  taken from: a `site` the request names must be that one. The create goes to the broker's `/v1/event-hooks` as a
  GitHub or HMAC one does (E3b-2).
- No secret exists yet, and a secret row needs `current_version` of at least 1 (`20260828018000`), so the opening stores
  none. The broker reserves the secret's id and derives the hook's **capture key**, an X25519 key pair, from the
  company's vault key (HKDF-SHA256, info `qorpera.event-hook-capture/v1`, the reserved id and the environment as salt).
  The database keeps only the public half.
- The private half is never stored and never leaves the keyring. `CloudSecretKeyring` gains two methods: one gives the
  public half for an identity, and one opens a capture box inside a callback, as `use` opens an envelope. Raw key bytes
  are zeroed after each call.
- **A stale capture key.** If the company's broker authority or its key changes before a capture, the stored public key
  is for a key that can no longer open the box. The hook keeps its address, so the agent never removes it or edits the
  endpoint at Stripe. Instead the broker derives the key again under the current authority and replaces it in one
  audited step, allowed only while no version of the hook's secret is sealed under the current key. Until then the
  capture reads answer "The hook's capture key must be made again" (55000). `/v1/event-hooks` takes a `rekey` request
  for a hook, and `manage_hook` makes it on its own when a capture meets this refusal.

**2. How the guest finds the value, and why it is Stripe's (E3c-3).** The call is
`computer_browser {action: vault_capture, hook, field: signing_secret, role, name}`. The `role` (a button or link) and
`name` name Stripe's Reveal control. The call carries no value, so the model cannot supply one. In the office:
1. **The page:** https, on the hook's site, in the page's own top document, not a frame (`VAULT_CAPTURE_WRONG_SITE`,
   `VAULT_CAPTURE_IN_FRAME`).
2. **The hook:** the page's text must show the hook's address, the 43-character path in its URL. This ties the page to
   this hook's endpoint, so endpoint A's secret is never stored under hook B (`VAULT_CAPTURE_WRONG_HOOK`).
3. **Nothing shown yet:** if text shaped like a secret (`whsec_` followed by letters, digits, `+`, `/` or `=`) is
   already on the page, the guest reloads it, and Stripe masks the secret again. If it is still there, it is not
   Stripe's reveal but text someone put on the page, and the capture is refused (`VAULT_CAPTURE_AMBIGUOUS`).
4. **The reveal:** a cover goes over the whole page, so the live viewer and any screen capture see the cover, never the
   value. Then the guest clicks the named control: exactly one, in the top document.
5. **The read:** the guest waits up to 5 seconds for exactly one secret-shaped value in the page's rendered text
   (`VAULT_CAPTURE_NOT_SHOWN` for none, `AMBIGUOUS` for two), reads it again 300 ms later, and the two reads must match
   (`VAULT_CAPTURE_UNSTABLE`).
6. **A whole value:** a token followed by `…` or `...`, or one with masking characters, is cut off
   (`VAULT_CAPTURE_PARTIAL`). Until the live run confirms Stripe's length, the check takes 16 to 200 characters after
   `whsec_`.
7. **Sealed, then hidden again:** the value is sealed (point 3) and added to the screen's private values
   (`CompanyComputerFilledValues`), so it is redacted from every snapshot, title and address for the screen's lifetime,
   as a typed password is. The computer's clipboard is cleared, the page is reloaded so Stripe masks it again, and only
   then is the cover removed.

A refusal seals and sends nothing. The proof that a value is Stripe's has two parts: the steps above (Stripe's own page
over TLS, naming this endpoint, with one value that appears only after the guest's click, read twice the same and
whole), and the first delivery that verifies under it (point 5).

**A shape guard, for every page.** If the model clicks Reveal itself, it must not see the value. So the guest treats any
secret-shaped text on any page as private, as it treats a filled value: snapshots show it redacted, and page and desktop
screenshots are refused while it is shown (`PRIVATE_FIELD_ON_SCREEN`). This also covers E3b's HMAC secrets, which are
`whsec_` and base64.

**3. From the guest to the broker, sealed and lease-proven as the fill is.**
- **The key comes from the database, never from the native host,** which could otherwise swap in its own key and read
  the value. The office reads it through its registry: one new method on the closed list
  (`cloud-company-computer-registry-http.ts`), `qorpera_native_office_hook_capture` (E3c-1, below). The office service
  builds that client from what the orchestrator gives the office VM at start (`registryUrl` in `qorpera-office-config`,
  the credential `qorpera-office-registry`) and posts over https to `<registryUrl>/rest/v1/rpc/<method>`, refusing a URL
  that is not https or has a path or user info, and checking the server's certificate against the system's store. So
  the read never passes through the run's native host, which lives in the job guest, reaches the office only through
  the native gateway (`qorpera-office-native`), and writes neither the office's configuration nor its credentials. The
  key the office seals to is the one the broker stored. G2's step that takes the office VM's service-role key away must
  keep this path (a narrower credential, still read by the office directly) and carry the new method.
- **The box:** A1-3's (`cloud-company-account-fill-box.ts`: an ephemeral X25519 key, HKDF-SHA256, AES-256-GCM), with its
  own schema and HKDF info (`qorpera.event-hook-capture/v1`), so a capture box never opens as a fill box or the other
  way round. Associated data `{schema, companyId, companyComputerId, computerGeneration, receiptId, hookId, field}`;
  payload `{schema, field, value, site, capturedAtMs}`.
- **The relay:** the office answers the perform with the box beside the content, a key only a `vault_capture` answer may
  carry, as only a screenshot's may carry `image`. The native host cannot open the box. It posts the binding, the
  receipt, the call's key and envelope, and the box to the broker's new `POST /v1/event-hook-captures`, which proves the
  binding with the run's lease first (G2-6a) and asks the database within 15 s.
- **The broker:**
  1. reads the capture context (`qorpera_folder_read_hook_capture`): the next version, and the facts the associated data
     needs;
  2. rebuilds the associated data from those facts, not from the native host's request;
  3. opens the box in the keyring, refuses one older than 90 s (60 s skew), and checks the value's shape again;
  4. opens the current version when the read gives one, and compares the two in constant time (`timingSafeEqual` over
     equal-length buffers; a length difference is itself "not the same"). The same value stores nothing and answers
     that version with `unchanged: true`;
  5. otherwise seals the value at the next version under the company's key with E3b-2's associated data, and stores it
     (`qorpera_folder_store_hook_capture`) with an audit row `hook_secret_captured`.

  The store is idempotent on the receipt. A version race answers "outcome unconfirmed", and the same receipt asks again.
  A box cut or changed in transit fails AES-GCM, and nothing is stored. The value and the envelope are zeroed after.

**4. What the agent sees afterwards.**
- **The tool's answer:** `{action: vault_capture, completed: true, captured: {hook, field: signing_secret, version,
  unchanged}}`. It never carries the value, and the receipt keeps only that answer.
- **The review card:** "Read a hook's signing secret off a web page into the vault", naming the hook and the field.
- **`list_hooks` and Settings:** `signingSecret.ready` turns true, and the card goes from "Waiting for its signing
  secret" to "Active" (#984). Snapshots of Stripe's page show the value redacted.
- **The descriptor:** a Stripe hook's `signingSecret` also gives `version`, `capturedAt` and `lastRefusal` (time and
  reason of the newest delivery refused under the current version), so the agent and Settings see a wrong capture as it
  happens.

**5. A wrong or partial capture.**
- **A partial, ambiguous or unstable read** is refused in the guest (point 2), with nothing sealed or sent. A box lost
  between the office and the broker leaves the receipt executing: the outcome is unknown, and the agent captures again.
  Reveal repeats, so this costs nothing.
- **A wrong capture that is stored** is a value that is Stripe's but not this endpoint's. The page check makes this
  unlikely. The likely case is a test-mode and a live-mode endpoint pointed at one hook: each mode has its own secret,
  so the rule is one hook per Stripe endpoint, and `manage_hook`'s description says so.
  - Deliveries are then answered 202 and refused afterwards ("The Stripe signature does not match", body dropped), so
    those events are lost to us, while Stripe counts them delivered.
  - The agent sees `lastRefusal`. The fix is to capture again, then resend the refused events from Workbench → the
    endpoint → **Event deliveries** (the Dashboard resends up to 15 days back, the CLI up to 30). A resent event keeps
    its id, so one that had verified is answered as a duplicate.
  - **The proof of a capture** is the first verified delivery. Workbench has no "send test" button, so the agent
    triggers a real test-mode event, or waits for the next real one.
- **Stop on the first mismatch (E3c-4).** Losing payment events without a word is the worst case for a company run on
  Qorpera, so no Stripe hook takes deliveries without this.
  - The hook keeps the newest secret version that has verified a delivery. When the verifier refuses a delivery with
    "does not match" under a captured version that has never verified one, it **holds** that version.
  - While the current version is held, intake answers the hook `not_ready` (409), as before its first capture, so
    Stripe retries every later delivery. The next capture makes a new version, which is not held, and the retries verify
    under it. Only the deliveries accepted before the hold are lost: the refused one, and any that raced it. The agent
    resends those.
  - The hold shows in `lastRefusal` ("held: the captured secret does not match"), so the agent captures again.
  - Once a version has verified a delivery, a later mismatch is refused as today and holds nothing. A rolled secret is
    covered by a new capture, and a forged delivery can no longer stop the hook.
  - It applies only to versions made by a capture, which is Stripe only. A GitHub or HMAC version is made by the broker,
    and a new fill does not make a new version, so a hold on one would never lift.
  - **Accepted risk:** anyone who knows a hook's URL can send one forged delivery that holds a never-verified version,
    so the hook answers 409 until the next capture. Nothing is lost, because Stripe retries for up to 3 days, and the
    agent sees the hold. The URL's 43-character path is the only barrier, and once a delivery verifies, the hold no
    longer applies.
- **Not chosen: check before storing.** Intake would keep the newest `not_ready` delivery's body and signature, and the
  broker would check a capture against it. That changes intake for little gain, and a forged held delivery could block a
  correct capture in the same way.

**6. Stripe's Reveal, Roll and copy buttons.**
- **Reveal** is the capture's own step. It repeats, so a capture can be redone at any time (§5.5's old "shows it once"
  was wrong). If the model clicks Reveal itself, the shape guard hides the value.
- **Roll** makes a new secret. Stripe expires the old one at once or up to 24 hours later, and while both live it signs
  every delivery with each, one `v1` per secret. Our verifier accepts any matching `v1` (`cloud-event-verification.ts`),
  so during the overlap the stored copy still verifies, and only the newest needs capturing.
  - After a roll the agent captures again at once. Rolling with an overlap (for example 1 hour) means no delivery is
    refused in between; with "expire now", deliveries are refused until the next capture (resend them as in point 5).
  - We add no roll action: Roll is a click on Stripe's page like any other. A suspected leak means Roll, then capture.
  - Test mode and live mode are separate endpoints with separate secrets, so each needs its own hook.
- **Copy** puts the value in the computer's clipboard, where the shape guard still hides it from snapshots, and the
  capture clears the clipboard. A model that reads the clipboard from a shell, or pastes the value into a file and reads
  that, gets a text tool result, so the runtime also redacts secret-shaped text in every text tool result that reaches
  the model: shell output, file reads, page text (E3c-2). A model that pastes it elsewhere on purpose, past these
  guards, is an agent that already controls the company's Stripe account: the capture keeps the value from the model,
  from members and from logs, not from an agent signed in to Stripe. The redaction is cheap defence in depth.

**No paste box.** Settings never takes a secret. It shows a Stripe hook's state ("Waiting for its signing secret", then
"Active", or its last refusal), and the only way a value gets in is the agent's `vault_capture`.

**E3c-1, the database (as built).** Migration `20260930344000`:
- **The site and the key.** `secret_site`'s check (`20260930160000`) also allows `stripe` with `dashboard.stripe.com`,
  and a Stripe request that names another site is refused (22023 "A Stripe hook's secret is taken from
  dashboard.stripe.com"). The new table `qorpera_event_hook_capture_keys`, granted to no role, keeps a Stripe hook's
  reserved secret id (unique), the broker authority, its key id and the 32-byte public key. The functions that write a
  key check it with `qorpera_company_computer_fill_key_valid`, which also refuses low-order points.
- **The opening.** E3b's effect takes a 10th argument, the capture key (the nine-argument one is dropped). Its callers:
  - `qorpera_folder_open_stripe_hook`, the broker's: the capture key and no envelope. In the hook's own step it inserts
    the key row, and no secret, version or audit row. The reserved id must be no secret's and no other key row's
    ("hook secret id is taken"). No reserved id, another key id, an envelope, or a key that is not a valid public key is
    refused (42501 "hook capture key is unavailable").
  - `qorpera_folder_open_signed_hook` (GitHub, HMAC): an envelope and no capture key, as before. A Stripe request there
    brings an envelope and is refused with the same 42501.
  - `qorpera_folder_manage_hook`, the host's: neither, so a Stripe proof is refused as the other signed ones are (0A000
    "A signed hook is opened through the vault"). A member's `qorpera_create_event_hook` refuses it with the same words
    (§6).
- **The renewal.** `qorpera_folder_describe_hook_capture_key` answers the hook's reserved id, the company, environment
  and key id the derivation needs, and `current` (the key row was made under this authority and its key).
  `qorpera_folder_replace_hook_capture_key` takes the new key id and public key and holds the key row FOR UPDATE:
  - the same authority, key id and public key again answers `replaced: false` and writes nothing;
  - once a version of the hook's secret is sealed under the authority's current key, it is refused (55000 "This hook's
    secret was already taken under the current key"): a capture under that key already proved it;
  - otherwise it replaces the row's authority, key id and public key and writes `hook_capture_key_replaced` (the
    reserved id, no version), answering `replaced: true`.

  The replace names no expected old key (no compare-and-swap): the key row's lock orders it with the captures, which
  take the same row FOR UPDATE.
- **The office's read,** `qorpera_native_office_hook_capture` (service_role only), writes nothing. It runs the office's
  own check of the call (`qorpera_native_office_operation` 'check': the executing `computer_browser` receipt of exactly
  this call and the run's screen lease on this computer), then needs a `vault_capture` of `signing_secret` on a
  `folder-v2` company, a run of a company agent whose requester is an owner or admin, and a live (active or paused)
  Stripe hook of the run's company. Its capture key must be made under the company's current active authority (else
  55000 "The hook's capture key must be made again"), and its secret, if any, must not be revoked (55000 "This hook's
  secret is gone from the vault"). It answers the hook's id, address and site, what the box is bound to (the company,
  the computer and its generation, the receipt, the field) and the capture public key.
- **The broker's read and store** share `qorpera_folder_hook_capture_context`, granted to no role: E3b's fill read, step
  for step, for a capture. It checks the call (22023 "hook secret capture call is malformed"), the run and its requester
  as `manage_hook` does, the hook (removed: 55000; not Stripe: 0A000 "This hook takes no secret from a page"), the
  capture key (55000 when it must be made again), the computer the run's screen lease holds at the call's generation,
  the secret at the reserved id (the hook's own and active, or none before the first capture), and last the receipt.
  The locks are in that order: the run check with the hook (rank 5, FOR SHARE, so a removal waits), the key row (FOR
  UPDATE, so one hook's captures take turns and the second reads the first's version), the computer (plain reads), the
  secret (FOR UPDATE), and the receipt.
  - `qorpera_folder_read_hook_capture` writes nothing. It answers the next version and the box's associated data, plus
    `current` (the current version's envelope, when it is sealed under this authority's key, for the broker's compare)
    and `captured` (this receipt's stored version, when there is one).
  - `qorpera_folder_store_hook_capture` stores the next version, once per receipt. The first capture makes the secret
    at the reserved id with E3b's columns (the company's, W1b's name, the hook's purpose, created by the run's
    requester) at version 1; a later one adds a version and raises `current_version`. It writes `hook_secret_captured`
    with the run, the receipt and the version, and a unique index keeps that to one per receipt. A replay answers the
    stored version (`replayed: true`). A version that is no longer the next one, or an insert that meets another, is
    an outcome the store cannot confirm (40003 "hook secret capture outcome is unconfirmed"), and the broker reads
    again for the same receipt.
- **The rest.** `qorpera_valid_office_browser_action` accepts `vault_capture` (`role` a button or link, `name` a
  non-blank string of at most 512 bytes, `hook` a uuid, `field` `signing_secret`). E3b's fill refuses a Stripe hook
  (0A000 "This hook has no secret the vault types"). The descriptor's `signingSecret` gains, for a Stripe hook only,
  `version`, `capturedAt` and `lastRefusal` `{receivedAt, reason}`, served by a partial index on refused deliveries.
  Empty ones are left out, so a Stripe hook before its first capture, and every GitHub or HMAC hook, keeps exactly
  `connectorId`, `secretName` and `ready`. The five broker functions are granted to `qorpera_secret_broker` only.

**Next: E3c-2, E3c-3 and E3c-4, in one release.**
- **E3c-2, the broker and the runtime:** `manage_hook`'s Stripe create (its E3b-2 refusal goes, and its description says
  one hook per Stripe endpoint, test and live mode apart); the folder client's new refusal words and its signed-create
  check (a Stripe create answers `ready: false`, and `version` and `capturedAt` appear only after a capture); the
  keyring's capture key, and the Stripe opening and `rekey` on `/v1/event-hooks`; `/v1/event-hook-captures`, the native
  host's relay and the review card; Settings' Stripe state; and the redaction of secret-shaped text in every text tool
  result that reaches the model.
- **E3c-3, the office image:** `vault_capture`'s page checks, cover, reveal, read and seal, the shape guard, the
  registry method and the perform answer's box.
- **E3c-4, the hold** (migration `20260930345000`, SQL test 420): the verifier's finish, intake's readiness and
  `lastRefusal`'s hold.

**Rollout (the coordinator's; in each PR's "Deploy needed" lines):**
1. E3c-1's and E3c-4's migrations.
2. The secret broker, then the vault's nginx on node 1, in the same `:10000` block as E3b's lines:
   `location = /v1/event-hook-captures` (POST only) through `$qorpera_operations_broker`, checked with `nginx -t`.
3. The runtime bundle and the office image, together. A Stripe hook opened before the office image can capture just
   waits: Stripe retries.

**Tests (E3c-1): SQL 419, on 405's office fixture** (924's `folder-v2` company, a live run holding a native screen lease
on the company's computer), with the company's broker authority:
- the broker opens a Stripe hook with its capture key (the hook and the key, no secret); a replay answers from the
  receipt; a GitHub hook opens as before; every refusal writes nothing;
- the key's description, and its replacement while nothing was taken under it;
- the office's read refuses any call but a `vault_capture` of a live Stripe hook of the run's company;
- the first capture (the office's read, the broker's read, the store and its replay); a second stores version 2, and
  only as the next version;
- a new broker key: the old capture key is refused until it is replaced, and a key that took a secret stays;
- while the hook is paused, every refusal of the reads and the store writes nothing (the call, the lease, the authority,
  the company, the receipt, the envelope, the version, Postgres' own session, a requester who is no longer an owner, a
  revoked secret); then another capture;
- the descriptor; the fill refusing a Stripe hook; a removed hook captured no more; the grants, the dropped
  nine-argument effect, the browser action's capture variant and the marker.

The races (two stores of one version, a replace beside a store) are left to a committed fixture, as 948 is 987's.
**SQL 987, 939 and 418** take E3c-1's words: a Stripe proof on the host's and the member's paths gets "A signed hook is
opened through the vault", and the broker's E3b opening refuses one with "hook capture key is unavailable".

**Tests (E3c-2 to E3c-4):**
- **SQL 420 (E3c-4):** a mismatch under a never-verified captured version holds it, and intake answers 409; the next
  capture lifts the hold; a mismatch after a verified delivery holds nothing; GitHub and HMAC versions are never held.
- **TypeScript:** the keyring's capture key (it never exposes raw bytes) and a capture box that never opens as a fill
  box; the broker route's proof and answers, the constant-time compare, and the native relay; the redaction of
  secret-shaped text in shell output, file reads and page text; the guest's checks against fixture pages (cut, two
  tokens, unstable, a frame, the wrong host, no address, a token already shown, the cover); the shape guard in snapshots
  and screenshots.
- **Deferred (needs Codex),** a live run against a Stripe sandbox, which also settles what Stripe's page does: the
  secret's exact length, whether the endpoint page shows the full URL, where the value sits before Reveal, the Reveal
  control's name, and the 409 retry schedule.

## 6. E4: hooks and mailboxes in Settings

Settings → Company connections lists hooks and mailboxes beside accounts, as `supabase/CLIENT-CONTRACT.md` already says
(step A3). Owners and admins can create, pause and remove them and see a hook's address. Every member sees a hook's name,
purpose and status. This is web only, on the existing RPCs (`qorpera_list_event_hooks`, `qorpera_create_event_hook`,
`qorpera_set_event_hook_status`, `qorpera_create_company_mailbox`). It is agreed with Interfaces, whose Mailbox page
reads the same mailboxes.

As built (`packages/web/src/app/views/settings-hooks.ts`, `packages/web/src/cloud/event-hooks.ts`): two sections,
Webhooks and Mailboxes, below the services, on the services' cards. A card shows the name (a mailbox by its email
address), purpose, status and last delivery, and who signs a signed hook. Owners and admins also see a webhook's URL to
copy, and add, pause, resume or remove (after a confirmation). Settings adds address-proven webhooks and mailboxes only:
a signed hook needs its sender's signing secret, and members never paste one (agents open those, §5.5). No SQL: all
four calls answer for `folder-v2` since E1. Next, with E3c-2 (§5.8): a Stripe hook's card shows "Waiting for its
signing secret", then "Active", or its `lastRefusal`.

E4b (migration 20260930280000, test 418): the member path now says the same. On a `folder-v2` company
`qorpera_create_event_hook` refuses a Stripe, GitHub or HMAC proof with the host's words (0A000, §5.5), after the
request's own checks and before any lock, and makes and marks nothing. Since E3c-1 (migration 20260930344000) those
are "A signed hook is opened through the vault" for Stripe too (test 418 checks it). A signed hook made there would
have no secret and answer every sender not_ready. Address hooks, mailboxes and the snapshot-v1 branch are unchanged.
W1b's member capture of a hook's secret stays snapshot-v1's too: on a `folder-v2` company
`qorpera_begin_cloud_secret_capture` refuses the `event_hook` connector with 0A000 ("A hook's signing secret comes from the vault"), after its own checks and before any
lock, for a new secret, over the vault's, and for a member's own. Other connectors are unchanged. The runtime contract's
amendment "events wake agents", item 2, says so (amended 9 October 2026).

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
