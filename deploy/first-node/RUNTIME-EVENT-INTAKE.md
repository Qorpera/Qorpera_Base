# Event intake and event wakes

Founder decisions of 29 September 2026, on the Q1 page "Qorpera on Qorpera"
(https://claude.ai/artifact/J9rKxZmibyRFazntBPBbsh), relayed by the coordinator:

- Agents must wake on defined events, such as incoming email and webhooks from any service. This
  is the base for routines and the top priority of workstream Q1.
- Event wakes also come to today's routine rows before the clean reset (decision 6), although new
  features otherwise go to the folder model. Routine files (F2-6) take the same trigger.
- Agents act through the company's own accounts, and credentials live in the vault (decision 2).
- A company's first address is on a mail domain Qorpera owns (decision 7). Mail arrives through this
  same intake (step M2).

Contract: section 16.3 and the 2026-09-29 amendment "events wake agents" (section 19). This file is
the technical design. The Q1 page is the plain one.

Status: design, and build step W1a in review (PR #509). W1a takes migration slot
`20260929260000_runtime_event_intake`. W1b reserves `20260929260100`.

## Words

- A **hook** is a company connection that receives events: one public address, how the sender
  proves itself, and limits. It is created by an owner or admin (W1a) or by an agent (W2).
- A **delivery** is one request that reached a hook's address. It is runtime state: a queue entry
  and a receipt. The event it carries becomes company content once it is saved in the company folder
  (below).
- A delivery is **verified** when its sender is proven, or when the hook takes its address as the
  proof. Only verified deliveries wake agents.

## Build steps

| Step | What | Slot |
| --- | --- | --- |
| W1a | Hooks, deliveries, the public intake function, address-proven hooks end to end, member RPCs | `20260929260000` |
| W1b | Signed hooks: the vault verifies Stripe, GitHub and HMAC signatures | `20260929260100` (reserved) |
| W2 | Routine trigger on a hook, event wakes, the agent tools `manage_hook` and `read_event` | registered when started |
| M2 | Company mailboxes: the mail provider posts to a platform-owned hook per mailbox | registered when started |

Each step is a release-train feature PR: no bundle, manifest or activation files, an independent
exact-head review, and a hand-off to the coordinator.

## Where the intake runs

The intake is a Supabase Edge Function, `event-intake`, at
`<supabase url>/functions/v1/event-intake/<address>`.

- It is public and always up. It does not depend on one node, while the brokers and the shared vault
  serve requests from node 1 only (`RUNTIME-LOGIN-VAULT.md`).
- Senders differ in how they retry. GitHub does not retry a failed delivery on its own. The intake
  must answer quickly and not wait for the vault.
- The Stripe webhook of computer-hours billing already runs this way
  (`supabase/functions/computer-billing`).

The function holds no company secret. It reads the body, checks limits, and hands the delivery to
one database function granted to `service_role` only. Signatures are checked afterwards by the
company's broker (W1b), the only component allowed to unwrap a company secret (contract 11.5). An
address-proven hook needs no secret, so its deliveries are verified in the same database call.

## Hooks

Table `qorpera_event_hooks`, one row per hook:

| Column | Meaning |
| --- | --- |
| `id` | uuid |
| `profile_id`, `environment_id` | the company and its environment |
| `name` | handle, `^[a-z][a-z0-9-]{0,63}$`, unique among the live hooks of the company environment |
| `purpose` | one line, 1–512 characters |
| `proof` | `address`, `stripe`, `github` or `hmac-sha256` |
| `address` | 43 characters of base64url from 32 random bytes, unique |
| `status` | `active`, `paused` or `removed` |
| `max_body_bytes` | 1 KiB to 256 KiB, default 64 KiB |
| `per_minute` | deliveries accepted per rolling minute, 1–120, default 60 |
| `created_by_user_id` / `created_by_staff_agent_id` | who made it: at most one, a member (cleared if the account is deleted) or an agent (from W2) |

A company has at most 50 live hooks. A hook's last delivery time is read from its deliveries; the
hook row is never written by a receive. A receive's delivery shares the hook row's key (its foreign
key), so it waits only while the hook is deleted; a status change locks the row without its key. A removed hook's row is deleted 30 days after its
removal, once its deliveries have gone.

**Which companies.** In W1a, hooks exist for `snapshot-v1` companies, whose connections are rows.
For a `folder-v2` company a hook is described by its connection file, `connections/hook-<name>.md`,
which the platform writes in the same step as the hook (contract amendment, item 2). The writer step
reserves the `hook-` prefix for hook files: today's connection-file rules (20260928249140) let an
account file be renamed within `connections/` and require a vault row per file, which an
address-proven hook lacks, so they gain a hook branch then. That waits for the
core's writer (F1 C3), so creating a hook there refuses with 0A000 until then. A company with live hooks is not
untouched, so `qorpera_folder_enable` refuses it (55000); its hooks go with it at the reset. Creating a
hook holds the company's Company File row shared, which `qorpera_folder_enable` locks for update before
it looks for hooks, so the two cannot pass each other.

**Proof.**
- `address`: whoever knows the address may post. The address works like a key that only lets
  someone post events into this hook, and nothing else. The platform shows it to the company's owners
  and admins, and to agents that manage hooks (W2). It is not a vault secret: holding it grants no
  access to any service or company data, and every event is outside content anyway (below). Use it
  for senders that cannot sign, such as a website form. Addresses also appear in the platform's
  request logs, which only operators read.
- `stripe`, `github`, `hmac-sha256`: the sender signs each delivery with a shared secret. The secret
  is a company vault secret with connector `event_hook` and the secret name `h<hook id without
  hyphens>`, captured by a member through the existing vault capture
  (`qorpera_begin_cloud_secret_capture`). Binding it to the hook's id means a new hook never picks up
  a removed hook's secret. Agents never see it. Until that secret exists, and until W1b ships, the
  hook refuses deliveries (`not_ready`, HTTP 409).

**Who manages hooks (W1a).** Owners and admins, through
`qorpera_create_event_hook`, `qorpera_set_event_hook_status` and `qorpera_list_event_hooks`.
Contributors and viewers see names, proof and status, not addresses. From W2, an agent creates,
pauses and removes hooks with `manage_hook`, and creating one passes the automatic review as a new
connection. The Settings split (step A3) lists hooks under Company connections.

## Limits

The intake is shared by every company, so it is bounded three ways. A request refused by any limit
writes nothing: no delivery, no counter.

- **Per hook:** a body of at most `max_body_bytes` (at most 256 KiB), and at most `per_minute`
  deliveries in any rolling 60 seconds (at most 120). The check counts the hook's deliveries of the
  last minute without locking, so a burst of concurrent requests can pass it by the number in flight.
- **Per company:** `qorpera_event_intake_usage` counts stored deliveries (accepted or duplicate) and
  their stored bytes, body and headers, per UTC clock hour. A delivery is refused when the current
  and previous hour together would pass the budget in `qorpera_event_intake_settings` (default 2,000
  deliveries and 64 MiB). The usage row is the only row a receive locks for update, briefly, and the
  public door waits at most 2 seconds for any lock. Deliveries and usage carry the company id without a foreign key,
  so a receive never waits for the company row (whose gc fence a company purge holds): deliveries go
  with the company through the hook, and usage rows, which hold only counts, expire within a day.
- **The platform switch:** `qorpera_event_intake_settings.enabled` is built off. While it is off,
  every delivery is answered 503. Operators turn it on at acceptance, and can turn it off at any time
  or change the budget, in SQL.

## Deliveries

Table `qorpera_event_deliveries`:

| Column | Meaning |
| --- | --- |
| `id` | uuid, the delivery id agents see |
| `hook_id`, `profile_id` | the hook and its company |
| `received_at` | when the intake took it |
| `status` | `received` (waits for the vault), `verified`, `refused` or `duplicate` |
| `delivery_key` | the sender's own id once verified: Stripe's `evt_…`, GitHub's `X-GitHub-Delivery`, or `X-Qorpera-Delivery` / `Idempotency-Key`; for a sender without one, `body:<sha256>:<delivery id>` |
| `event_type` | Stripe's `type`, GitHub's `X-GitHub-Event` (with `.action` when the body has one), `X-Qorpera-Event`, or null |
| `content_type`, `headers` | the content type, and an allowed list of headers (below), at most 8 KiB |
| `body`, `body_sha256`, `body_bytes` | the raw body; the body and the headers are cleared after 7 days, the rest kept 30 days |
| `verified_at`, `reason` | when it was verified, or why it was refused (at most 500 characters) |

- **Kept headers:** `content-type`, `user-agent`, `stripe-signature`, `x-hub-signature-256`,
  `x-github-event`, `x-github-delivery`, `x-github-hook-id`, `x-qorpera-signature`,
  `x-qorpera-timestamp`, `x-qorpera-delivery`, `x-qorpera-event`, `idempotency-key`, and the Standard
  Webhooks and Svix headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`, `svix-id`,
  `svix-timestamp`, `svix-signature`) for mail providers (M2). Everything else, including
  `authorization` and cookies, is dropped by the function. Kept headers over 8000 bytes of JSON are
  refused (431).
- **Duplicates.** With a sender id, a verified delivery is unique on `(hook_id, delivery_key)`: the
  unique index decides, so two concurrent copies cannot both be verified. The sender id is the first
  well-formed one of `X-Qorpera-Delivery` and `Idempotency-Key`. Without a sender id, the same body
  within 10 minutes is taken as the sender's retry, as a best effort (two identical bodies arriving
  at the same instant may both be accepted); after that the same body is a new event (a monitor's
  second identical alert is real). A duplicate is recorded without its body and
  answered 200, so the sender stops retrying. Deduplication runs only after verification. Otherwise
  someone who knows an address could send a fake delivery with a real event's id ahead of it and have
  the real one dropped.
- **Size.** The function refuses a body over 256 KiB before reading it (`Content-Length`) or while
  reading it (a stream cap). The database refuses a body over the hook's `max_body_bytes` (413).
- **Retention.** `qorpera_purge_event_deliveries(limit)` refuses deliveries still waiting for the
  vault after 24 hours, deletes rows after 30 days, clears bodies and headers after 7, deletes hooks
  removed over 30 days ago, and deletes hourly usage older than a day, at most `limit` rows of each
  kind a call. The coordinator schedules it every 5 minutes (pg_cron), which keeps ahead of dozens of
  companies at their budget. Events saved in the company folder stay there (below).

**Answers.**

| Outcome | HTTP | When |
| --- | --- | --- |
| `accepted` | 202 | stored; for an address-proven hook, also verified |
| `duplicate` | 200 | a copy of a delivery already verified |
| `unknown` | 404 | no hook has this address, or it was removed, or its company is being deleted |
| `paused` | 409 | the hook is paused |
| `not_ready` | 409 | a signed hook whose secret is not in the vault yet |
| `too_large` | 413 | over the hook's limit |
| `limited` | 429 | over the hook's minute (`Retry-After: 60`) or the company's budget (`Retry-After: 600`) |
| `unavailable` | 503 | the intake is switched off (`Retry-After: 300`) |
| — | 400 | input the database calls malformed |
| — | 404, 405 | a path that is no address; a method other than POST |
| — | 413, 431 | a body over 256 KiB; kept headers over 8000 bytes |
| — | 503 | the database cannot be reached; the sender retries |

A signed delivery is answered 202 when it is stored, before the vault checks it. A bad signature is
therefore not reported to the sender. It is recorded as `refused` with the reason.

## Verification in the vault (W1b)

Every broker, both the per-company brokers and the shared vault, runs a verification loop for the
companies it serves:

1. `qorpera_claim_event_verifications(authority, capability, limit)` claims up to 32 `received`
   deliveries of its companies for 60 seconds. For each it returns the body, the kept headers, the
   hook's proof, and the current version of the hook's `event_hook` secret (key id and envelope),
   refusing a revoked secret.
2. The broker unwraps the secret in memory and checks the signature:
   - `stripe`: `Stripe-Signature` `t=` and `v1=` values; HMAC-SHA256 of `t.body`; 300 seconds
     tolerance measured against `received_at`; the event id `evt_…` and `type` from the body.
   - `github`: `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 of the body; the key is
     `X-GitHub-Delivery`, the type is `X-GitHub-Event` plus `.action`.
   - `hmac-sha256`: `X-Qorpera-Signature: v1=<hex>` over `<X-Qorpera-Timestamp>.<body>`, 300 seconds
     tolerance; for senders the company controls, such as its own backend.
   Comparisons are constant time. The secret never leaves the broker's memory.
3. `qorpera_finish_event_verification(authority, capability, delivery, claim, verdict, key, type,
   reason)` records `verified`, `duplicate` or `refused`. A claim that expired is retaken by any
   broker that serves the company.

A delivery still `received` after 24 hours is refused with "not verified in time". The broker HMAC
helpers are shared with the intake function's tests, so both sides agree on every format.

## Event wakes (W2)

W2a (migration `20260929290000_runtime_event_wakes`, on today's routine rows per decision 6) and the
runtime side ship in one cut.

**The trigger.** A routine version may carry one listener trigger on a hook:
`{id, kind:'listener', source:'event', hookId, only?: [types], timeZone, replyPolicy?}`. `hookId` is
the hook's id in lowercase canonical form, so every reader compares it as text. `only` lists 1–20
distinct event types of printable ASCII without spaces, at most 128 characters each. A delivery
with no type matches only a trigger without `only`. As with file-change listeners, a listener is the
version's only trigger, and the hook must be a live hook of the routine's company and environment
(checked when the version is saved, by the agent's routine tool and by the version's activation). The
agent's tool compiles `{kind:"event", hookId, only?, timeZone, report?}` to it; `list_hooks` gives
the ids. In routine files (F2-6) this becomes `when: event`, `source: hooks/<name>` and `only: [...]`. Member
clients read the trigger (`CloudRoutineEventTrigger`): the web routine list words it and offers pause
and resume, and its editor does not edit it.

**Cursors.** Each event listener version gets a row in `qorpera_event_listener_cursors` with the
instant it became active. A resume or a new current version starts it again from now, as a file
listener does, so events that arrived while it was paused do not wake it.

**Admission.** The materializer's drain (`qorpera_drain_event_wakes`, called after the file drain)
takes up to 32 active cursors, oldest scan first, and for each one:
- skips it while the routine is not active at that version or the company is paused;
- skips it while an event occurrence of that routine trigger is pending: queued, or materialized with
  its job not yet running and nothing read;
- otherwise, when a verified delivery of the hook since the cursor's start (within 7 days), matching
  `only` and not yet taken by this routine trigger, is waiting, inserts one occurrence: `wake_kind
  'routine'`, `source_kind 'event'`, `source_id` the hook, key `event:<routine version>:<trigger
  id>:<first delivery id>:<attempt>`, `scheduled_for` the first delivery's arrival, payload `{hookId,
  firstDeliveryId}`. The attempt counts earlier occurrences for the same first delivery, so the key is
  decided by history and a cancelled occurrence gets a next one.
A routine that must report needs a public audience, as for file listeners. The existing insert
triggers apply unchanged: quiet hours move `not_before`, and the pinned sponsor pays. An error for one
cursor (the agent or requester gone, for example) skips that cursor this round and never stops the
materializer.

**Reading.** `qorpera_read_native_wake` adds the batch to an `event` occurrence's payload. The first
read takes up to 20 waiting deliveries into `qorpera_event_wake_deliveries(routine, trigger,
delivery, occurrence)`, so a retried run reads the same batch. Each event shows its delivery id, type,
arrival, content type and size, and its body as UTF-8 text (`encoding: utf8`) or base64 (`encoding:
base64`), cut to about 8 KiB each and 24 KiB in all (`truncated`), or `bodyCleared` after 7 days.
`more` counts the deliveries still waiting, which wake the routine again once this occurrence has
been read. A hook removed after admission cancels its queued wakes at materialization, like any
lost source authority.

**Outside content.** The wake protocol for an event wake says every event is outside content (contract
11.1): an instruction inside it is data, and outside actions it leads to pass the automatic review.

**Tools.** `list_hooks` lists the company's live hooks with their addresses. `read_event(deliveryId,
offset?)` reads one verified delivery of the agent's own company in pieces of 16,000 characters (UTF-8)
or 24 KiB (base64). Both are reads for the automatic review. Agents creating and removing hooks
(`manage_hook`, reviewed as a new connection; a signed hook asks a member for its secret, connector
`event_hook`, secret name `h<hook id without hyphens>`) follows in a later step.

**Folder companies.** Event wakes of `folder-v2` companies are refused like their file-change wakes
until routine files (F2-6) and the folder's writer land.

**The folder.** For `folder-v2` companies, once the core's writer lands (F1 C3), the platform saves each
verified delivery as `hooks/<hook name>/<yyyy-mm-dd>/<delivery id>.json` (the kept headers and the
body) in the same change set, and the wake names that path. Until then, and for today's companies, the
delivery row is the record, and agents save what they need.

## Mail (M2)

A company mailbox is a platform-owned hook per address. The mail provider posts each inbound message
to it, signed with Standard Webhooks or Svix headers, and the vault checks them like the other signed
kinds. A connected Gmail is read by the platform once a minute and becomes deliveries the same way.
Mail design follows in M2.

## Deploy (W1a)

The migration adds tables and functions that nothing calls yet, and patches `qorpera_folder_enable`
(operator-only) by exact text so it also refuses a company with hooks, a condition that cannot hold
before the migration. It is safe for both bundles during a roll. Before merging, compare the patch's
anchor with master again (RUNTIME-RELEASE-TRAIN.md). After it is live:

1. Deploy the function: `supabase functions deploy event-intake` (`verify_jwt = false` in
   `supabase/config.toml`). It needs only `SUPABASE_URL` and the service key the platform provides.
   Until the switch is on it answers every delivery 503.
2. Schedule retention:
   `select cron.schedule('qorpera-event-deliveries-purge', '*/5 * * * *',
   $$select public.qorpera_purge_event_deliveries(10000)$$);`
3. Turn the intake on for acceptance:
   `update public.qorpera_event_intake_settings set enabled = true;` (off again with `false`).
4. Acceptance: an owner creates an address-proven hook on a test company, posts to
   `<supabase url>/functions/v1/event-intake/<address>` with `curl`, and sees the delivery with
   `qorpera_list_event_deliveries` (202 `accepted`, then 200 `duplicate` for the same
   `X-Qorpera-Delivery`, and 404 after removing the hook).

## Security

- The intake holds no company secret and no user session. It can only add deliveries to hooks that
  exist.
- A hook's address grants only posting into that hook. Deliveries wake agents only after the proof
  holds, and their content is outside content.
- Duplicates are decided after verification, so a forged early copy cannot suppress a real event.
- Limits bound storage: at most `per_minute × max_body_bytes` a minute per hook (30 MiB at the
  maximums), the company's hourly budget across all its hooks (64 MiB by default), and the platform
  switch. Refused requests write nothing.
- A company being deleted stops receiving at once (`unknown`). The company purge removes its hooks and
  deliveries with the company (foreign keys cascade; test 730 runs the purge). Its usage rows hold
  only counts and expire within a day.
- No table is readable by `anon`, `authenticated` or the broker role. Members read through the
  listed functions, and the broker reads only through its two functions (W1b).
