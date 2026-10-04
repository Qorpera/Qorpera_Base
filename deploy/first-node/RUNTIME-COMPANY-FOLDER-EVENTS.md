# Hooks, mailboxes and event wakes on the folder core (C4, Q1)

Status: plan, agreed 4 October 2026 (Q1, qorpera-cb, with the coordinator, F2 and A1; §10). Nothing here is built yet.
Reserved: E1 is migration `20260930060000` with SQL test 912; E2 is migration `20260930061000` with SQL test 913.

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

### 3.2 The files

| Kind | Path | Settings, written only by the platform | Body |
|---|---|---|---|
| hook | `connections/hook-<stem>.md` | `id` (the hook's uuid), `service: hook`, `name`, `proof` (`address`, `stripe`, `github` or `hmac-sha256`), `status` (`active` or `paused`), `max_body_kib`, `per_minute`, `created_by`, `created_at` | the hook's purpose; members and agents may edit it |
| mailbox | `connections/mailbox-<stem>.md` | `id` (the mailbox's hook uuid), `service: mailbox`, `address` (`<local>@<mail domain>`), `status`, `created_by`, `created_at` | the mailbox's purpose |

- **What a file never holds:** the hook's address (it is a capability, shown only to owners and admins, as today), a
  signing secret, or anything from the vault.
- **The stem:** the hook name or the mailbox's local part, mapped to the folder's name rule (lowercase letters, digits,
  single hyphens). It is cut so that the whole name stays within 64 characters (59 after `hook-`, 56 after `mailbox-`).
  On a clash the writer adds `-2`, `-3` …, as P22 does for accounts.
- **Removal:** a removed hook or mailbox has no file. The writer deletes the file, as it does for a revoked secret.
- **Pausing:** a paused hook keeps its file with `status: paused`.
- **An agent's routine names a hook by `id`** (§4.1). The file is where agents find that id. Hook names are freed on
  removal, so a name could later point at a different hook; an id cannot.

### 3.3 The connection-file machinery gains hooks

P22 is keyed by a uuid, the vault secret's id (`qorpera_folder_connection_file_marks`, `_work`, `_index`), and the index
has no foreign key to the vault (`20260928249140:24-41`). So E1 extends P22 rather than adding a second writer. A1, which
owns P22, agreed on 4 October. F2 owns the writer (P22b).

- **A kind, not an overloaded id:**
  - `_marks`, `_work` and `_index` gain `subject_kind` (`vault`, `hook` or `mailbox`, default `vault`). On `_work` and
    `_index` it becomes part of the key: (kind, id).
  - The state function branches on the kind, never on "no vault secret has this id". That test would turn ambiguous once
    a secret is purged, and it would blur a revoked secret's "no file" with a hook's.
- **Marks:** triggers on `qorpera_event_hooks` mark (`hook` or `mailbox`, the hook's id) due.
  - They fire only in a folder-v2 environment, and only when a field the file shows changes: insert; `status`, `purpose`,
    `max_body_bytes` or `per_minute`. A mailbox is a hook row with `proof = 'mail'`, so the kind follows `proof`.
  - P22a's invariants stay (`20260928469150:1-36`): a mark is a plain insert with a generated key that waits on nothing.
    Its only foreign key is the company row, which every folder-v2 hook change already holds KEY SHARE (§3.4).
- **The claim:**
  - It still never waits for a hook change or a company being deleted.
  - It creates work rows in one order, kind then id.
  - It locks only work rows, the marks it consumes, and the companies it key-shares SKIP LOCKED. It never touches a hook
    row, so the hook functions' order (§3.4) can't meet it in a cycle.
- **State:** `qorpera_folder_connection_file_state(kind, id)` reads the hook, and its mailbox row if it has one, and answers
  the allow-list above. It never answers the address, a signing secret, a token or a verification secret. A removed hook
  or mailbox answers "no file", as a revoked secret does. Finish is unchanged except for the kind.
- **Rules:** the connection rules (`20260928249140:198-232`) gain a hook branch.
  - A file whose stem starts `hook-` or `mailbox-` must name a hook of this company and environment: `proof = 'mail'`
    exactly for `mailbox-`.
  - Only the platform creates or deletes such a file, and only to match the hook row (live → present, removed → absent).
  - Members and agents change the body only.
  - A move must keep the prefix and stay inside `connections/`.
  - No vault file may take either prefix. The rules refuse it, and the name derivation
    (`qorpera_folder_connection_file_state`) gives a vault connection whose natural name starts with `hook-` or
    `mailbox-` a `connection-` prefix instead. A test shows that a website account on a site named `hook-x` or
    `mailbox-y` never lands on a hook's file. This reserves the prefixes, which `RUNTIME-EVENT-INTAKE.md:96-99` promised
    but nothing yet does.
- **The writer** (`packages/object-gateway/src/connection-files.ts`) and the parser
  (`packages/cloud-client/src/company-state-files.ts` `connection()`) gain the two allow-lists. The writer stays behind
  `QORPERA_CONNECTION_FILE_WRITER`, which the coordinator switches on with the first live test.

### 3.4 Creating, pausing and removing on folder-v2

The old functions take the company row `FOR NO KEY UPDATE`, which the folder core forbids (core §3: never stronger than
KEY SHARE). Each of them gets a folder-v2 branch in core §3's order:

1. the role check and a plain read of the company's core and deletion state (a company being deleted answers 55000, as
   today);
2. `qorpera_folder_company_enter(env, profile, targets, refuse_paused => false)`: the fence KEY SHARE, the company row KEY
   SHARE (rank 0), and the acting member KEY SHARE (rank 1). Creating a hook starts no work, so a paused company may
   still create one, as on the old core.
3. **Pause and remove:** the hook row `FOR NO KEY UPDATE` at rank 5, where hooks take their place among the connection
   rows in the structured lock's table order (an exact-text patch adds `qorpera_event_hooks` to
   `qorpera_folder_structured_lock`, after the tables already there);
4. **Create only:** a per-company advisory transaction lock on `qorpera.event-hooks:<profile>`, taken last. It serializes
   the caps (50 live hooks, 20 mailboxes), which the company row lock used to. Only these functions take it, and they
   wait on nothing after it, so it can't form a cycle.
5. the insert or update, and the mailbox row, as today. The file mark comes from the trigger.

The rest is unchanged: grants (owners and admins, through `authenticated`), names, reserved names, the mail domain, the
Qorpera-name refusal, limits and addresses.

Unchanged too: the `qorpera_folder_enable_internal` check that a company with live hooks can't *become* folder-v2. It
guards converting an old company, which no longer happens.

### 3.5 Tests (E1)

- **A new SQL test, on the 634 or 856 fixture:**
  - create, pause, resume and remove a hook and a mailbox on folder-v2;
  - the caps under concurrency (dblink: two creates at 49 live hooks, exactly one wins);
  - the refusals: not an owner or admin, a company being deleted, a reserved name, no mail domain;
  - the marks; the claim's state for a hook and a mailbox (no address, no secret);
  - the rules: the platform creates and deletes the file; a member edits the body; prefix theft, a wrong `proof`, and a
    move out of `connections/` are refused;
  - the lock order, by a probe that a folder commit and a hook removal never deadlock.
- **Beside 852 and 853 (P22's vault tests):** hook and mailbox cases for marks, claim, state and the prefix collision.
  852 and 853 run again unchanged, to show the vault answers didn't move.
- **Existing tests:** the snapshot-v1 hook and mailbox tests stay green. 708/731's folder refusals change to the new
  expectations.
- **TypeScript:** the writer's allow-lists and the parser's two kinds.

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

- **The routine rules** require `hook` to be a live hook of the same company and environment, on save, move and
  handover. A problem `hook_unavailable` is reported as the file's structured problem; without this rule, W2's trigger
  would abort the whole commit with 42501.
  - The rule is checked twice: on the plain read, and again in decide, under the hook's lock. A hook removed between the
    read and the lock refuses the save, rather than saving a routine whose listener can never fire (F2, 4 October).
- **The commit** takes each named hook row `FOR SHARE` at rank 5, through the structured-lock targets.
  - `qorpera_event_hooks` goes last in rank 5's table order, after routines and every other index table.
  - Every writer of a hook row takes it at that same place, after the routines it holds, and nothing after rank 5:
    E1's create, pause and remove; E3's tool; the event drain's KEY SHARE.
  - So a save and a removal serialize. Either the save sees the hook removed, or the removal waits for the save and then
    deactivates the routine's cursor through the existing remove trigger.
- **The compiled trigger** is byte-identical to the one W2 stores for old-core routines. So the cursor trigger, the event
  drain and the member mail reads (which join cursors) read one shape.

### 4.3 The event drain (`events`, on the shared folder drains)

The drain follows P29's contract (`RUNTIME-COMPANY-FOLDER-LISTENER.md` §9) and #803's shape.

- **The due list:** `qorpera_folder_event_wakes_due(p_after_environment, p_limit)` is a plain read. It lists the folder-v2
  environments that have an active event cursor with a verified delivery after the cursor's mark and no open event wake
  for that trigger. It leaves out companies being deleted and paused ones: paused events wait, as W2's drain skips paused
  companies (`WAKES:277`).
- **One company:** `qorpera_folder_event_wakes_company(p_environment_id, p_limit ≤ 64)`, in one transaction:
  1. a plain read of the due cursors and their routine, requester, agent and execution authority;
  2. `qorpera_folder_company_enter(…, refuse_paused => true)` with those targets: requesters at rank 1, agents at 2,
     authorities at 3, each routine `FOR NO KEY UPDATE` and its hook `KEY SHARE` at rank 5;
  3. the cursors `FOR UPDATE SKIP LOCKED`, as run-owned rows after rank 9;
  4. the checks again under the locks: routine current and active, hook live, quiet hours;
  5. the target sessions KEY SHARE;
  6. `qorpera_folder_admit_wakes` only if a wake will be inserted;
  7. the inserts in subtransactions. Each is a wake occurrence with `source_kind 'event'`, `source_id` the hook id, and
     W2's occurrence key and payload. Then `qorpera_event_wake_deliveries`, then the cursor advance.

  It answers `busy` on 55P03/40P01, and `paused`, `idle`, `deleting` or `not_folder` rather than raising. Its bounds are
  W2's: one open wake per trigger, at most 20 deliveries per wake, retries after 1, 4, 16 and 64 minutes.
- **Scheduling:** one `FOLDER_DRAINS` entry (`events`) in `runner-orchestrator.ts`, and one `CLOUD_FOLDER_DRAINS` entry
  after `listen`. Re-pin the Runner Orchestrator, shared execution and LXD provider artifacts. Deploy the migration, then
  the edge function, then the orchestrator.

### 4.4 The gate, the read, the runtime

- **The gate:** `qorpera_folder_wake_authorized` drops `event` from its refusal list and checks that the hook is still
  live, as W2's patch does on the old gate. This is an exact-text patch by its own anchor, so it composes with #803 and
  3i-b, which drop other kinds.
- **The read:** `qorpera_folder_read_wake` adds W2's event batch (`qorpera_event_wake_payload`). The runtime already
  parses the envelope (`packages/runtime/src/cloud-wake-bus.ts:403-450`).
- **The runtime:** `manage_routine` on folder-v2 accepts `event` and writes `when: event` into the routine file
  (`cloud-routine-tools.ts:530-533` keeps refusing `file_change` only if P29 hasn't lifted it by then).

### 4.5 Tests (E2)

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
