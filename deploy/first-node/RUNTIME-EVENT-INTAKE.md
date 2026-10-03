# Event intake and event wakes

Founder decisions of 29 September 2026, on the Q1 page "Qorpera on Qorpera"
(https://claude.ai/artifact/Y74zt9zUc35EbeJ3MN64mh), relayed by the coordinator:

- Agents must wake on defined events, such as incoming email and webhooks from any service. This
  is the base for routines and the top priority of workstream Q1.
- Event wakes also come to today's routine rows before the clean reset (decision 6), although new
  features otherwise go to the folder model. Routine files (F2-6) take the same trigger.
- Agents act through the company's own accounts, and credentials live in the vault (decision 2).
- A company's first address is on a mail domain Qorpera owns (decision 7). Mail arrives through this
  same intake (step M2).

Contract: section 16.3 and the 2026-09-29 amendment "events wake agents" (section 19). This file is
the technical design. The Q1 page is the plain one.

Status: W1a is live (v150, `20260928259260_runtime_event_intake`) and W2 is live (v151,
`20260928269290_runtime_event_wakes`), both accepted; the intake is switched on. M2a is merged
(`20260928299650_runtime_company_mailboxes`, release v154), with mail switched off until the domain exists.
M2b is merged (`20260928309740_runtime_company_mail_sending`, release v155), with sending switched off, and so is
the founder's sender-name rule (`20260928319810_runtime_company_mail_sender_names`). W1b, signed hooks, is merged
(`20260928409980_runtime_event_signed_hooks`, release v165, then a broker roll). Plus addresses and find_mail are in
review (`20260928429982_runtime_company_mail_find_and_tags`), and so are attachments
(`20260928429984_runtime_company_mail_attachments`, M2c-1).

## Words

- A **hook** is a company connection that receives events: one public address, how the sender
  proves itself, and limits. It is created by an owner or admin (W1a), and later by an agent (W3).
- A **delivery** is one request that reached a hook's address. It is runtime state: a queue entry
  and a receipt. The event it carries becomes company content once it is saved in the company folder
  (below).
- A delivery is **verified** when its sender is proven, or when the hook takes its address as the
  proof. Only verified deliveries wake agents.

## Build steps

| Step | What | Slot |
| --- | --- | --- |
| W1a | Hooks, deliveries, the public intake function, address-proven hooks end to end, member RPCs | `20260928259260` |
| W1b | Signed hooks: the vault verifies Stripe, GitHub and Standard Webhooks signatures | `20260928409980` |
| W2 | Routine trigger on a hook, event wakes, the agent tools `list_hooks` and `read_event` | `20260928269290` |
| W3 | Agents create, pause and remove hooks (`manage_hook`) | registered when started |
| M2a | Company mailboxes, receiving: owners create them, the mail provider's webhook fills them, routines wake on mail | `20260928299650` |
| M2b | Sending as a mailbox, as the agent with an AI line: `send_mail`, the outbox and its sender | `20260928309740` |
| M2b+ | Founder decisions of 1 October: no sender that reads as Qorpera | `20260928319810` |
| M2c-1 | Attachments: an agent saves a received one into the company folder, and sends company files | `20260928429984` |
| M2c-2 | Threads and sent mail as files in the folder | registered when started |
| I5a | Members read mail (the Interfaces Mailbox): threads, mailboxes, waiting sends | `20260928439980` |

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
it looks for hooks, so the two cannot pass each other. Creation locks the company row without its
key, so it never deadlocks with enable, which references the company only through foreign keys after
taking the Company File row.

**Proof.**
- `address`: whoever knows the address may post. The address works like a key that only lets
  someone post events into this hook, and nothing else. The platform shows it to the company's owners
  and admins, and to agents in runs an owner or admin started (W2). It is not a vault secret: holding it grants no
  access to any service or company data, and every event is outside content anyway (below). Use it
  for senders that cannot sign, such as a website form. Addresses also appear in the platform's
  request logs, which only operators read.
- `stripe`, `github`, `hmac-sha256`: the sender signs each delivery with a shared secret, in Stripe's,
  GitHub's or the Standard Webhooks scheme (`hmac-sha256`, which Svix's senders also use). The secret
  is a company vault secret with connector `event_hook`, the secret name `h<hook id without
  hyphens>` and the field `signing_secret`, captured by an owner or admin through the existing vault
  capture (`qorpera_begin_cloud_secret_capture`); the hook's descriptor names it (`signingSecret`).
  Binding it to the hook's id means a new hook never picks up a removed hook's secret, and removing
  the hook revokes it. Agents never see it. Until that secret exists the hook refuses deliveries
  (`not_ready`, HTTP 409).

**Who manages hooks (W1a).** Owners and admins, through
`qorpera_create_event_hook`, `qorpera_set_event_hook_status` and `qorpera_list_event_hooks`.
Contributors and viewers see names, proof and status, not addresses. From W3, an agent creates,
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
  every delivery that reaches the database (a POST to a well-formed address) is answered 503, before
  the address is looked up. Operators turn it on at acceptance, and can turn it off at any time or
  change the budget, in SQL.

## Deliveries

Table `qorpera_event_deliveries`:

| Column | Meaning |
| --- | --- |
| `id` | uuid, the delivery id agents see |
| `hook_id`, `profile_id` | the hook and its company |
| `received_at` | when the intake took it |
| `status` | `received` (waits for the vault), `verified`, `refused` or `duplicate` |
| `delivery_key` | the sender's own id once verified. Address hooks: `X-Qorpera-Delivery` / `Idempotency-Key`, or for a sender without one `body:<sha256>:<delivery id>`. Signed hooks (W1b) take an id the signature covers: Stripe's `evt_…`, the Standard Webhooks `webhook-id`, and for GitHub, which signs no id, `sig:<signature>` |
| `event_type` | `X-Qorpera-Event`; Stripe's `type`; GitHub's `X-GitHub-Event` (with `.action` when the body has one); the Standard Webhooks body's `type`; or null |
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
  the real one dropped. For the same reason a signed hook's sender id is always one the signature
  covers (W1b): a replay of a signed delivery under another id would otherwise verify and take the
  id of an event still to come.
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
| — | 404, 405 | a path that is not a hook address ("This is not a hook address"); a method other than POST |
| — | 413, 431 | a body over 256 KiB; kept headers over 8000 bytes |
| — | 503 | the database cannot be reached; the sender retries |

A signed delivery is answered 202 when it is stored, before the vault checks it. A bad signature is
therefore not reported to the sender. It is recorded as `refused` with the reason.

## Verification in the vault (W1b)

Migration `20260928409980_runtime_event_signed_hooks` and the runtime's `cloud-event-verification.ts`.

**Creating.** Owners and admins now create `stripe`, `github` and `hmac-sha256` hooks with
`qorpera_create_event_hook`. The descriptor carries `signingSecret: {connectorId: "event_hook",
secretName, ready}`. An owner or admin saves the sender's signing secret (Stripe's `whsec_…`, GitHub's
webhook secret, or a Standard Webhooks `whsec_…` secret, which the company makes for its own backend or a
Svix sender shows) through the vault's capture with that connector and name and the field
`signing_secret`; `ready` turns true once it is in the vault. Until then the hook answers `not_ready`.
Capture needs the company's vault (a broker authority), so a company without one cannot make a signed
hook ready. A new version of the secret (the capture with the existing secret id) takes effect at the
next claim. Removing the hook, by whatever path, revokes the secret with an audit event, as a member's
revoke would (a trigger on the hook's status).

**Receiving.** With the secret in the vault, a signed delivery is stored as `received` with no
sender id and no type, counted against the limits like any other, and answered 202 `accepted`. A
bad signature is therefore never reported to the sender; it is recorded as `refused`.

**Checking.** Every broker checks the deliveries of the companies it serves, on each company's own
broker authority. A company's own broker claims for its company on every pass. The shared vault first
asks once which of its companies have deliveries due
(`qorpera_broker_principal_event_verifications_due`, at most 1000 companies a call) and claims only for
those. A pass runs every five seconds and makes up to four claims.

1. `qorpera_claim_event_verifications(authority, capability, limit)`, broker role only, claims up
   to 16 `received` deliveries of the authority's company, oldest first, for 60 seconds, counting an
   attempt on each. Each comes with the hook's proof, the arrival in whole seconds, the kept headers,
   the body (at most 256 KiB) and the current version of the hook's secret, sealed (key id, envelope,
   digest). It refuses at once, and counts in `refused`, what no check could fix:
   - a removed hook ("The hook was removed");
   - an address hook's delivery ("The hook is not signed");
   - a secret that is gone or revoked ("The hook's signing secret is gone");
   - one sealed for another authority ("The hook's signing secret must be saved again");
   - a delivery whose body is gone ("The delivery's body is gone");
   - a delivery claimed five times ("The vault could not check it").
   A call looks at up to four times `limit` rows, and the broker claims again while a claim refused
   any, so a backlog of them never holds up a delivery behind it.
2. The broker opens the secret in memory and checks the signature, comparing in constant time. The
   sender id is always one the signature covers:
   - `stripe`: `Stripe-Signature` `t=` and one or more `v1=`; HMAC-SHA256 of `<t>.<body>` with the
     secret as given; within 300 seconds of the arrival. The sender id is the event's `id` (a Stripe
     event without one is refused) and the type is its `type`, both from the signed body.
   - `github`: `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 of the body. GitHub signs neither
     `X-GitHub-Delivery` nor `X-GitHub-Event`, so the sender id is `sig:<signature>`: GitHub's own
     redelivery and anyone's replay of a body are duplicates. The type is `X-GitHub-Event`, followed by
     `.<action>` when the body has one (`pull_request.opened`). The name is unsigned: a replay under
     another name is a duplicate once the genuine copy is verified, but someone who held the signed body
     before GitHub's own copy arrived could land it first under another name, which a listener's `only`
     filter would act on. GitHub signs no time, so a body replayed after its row is deleted (30 days) is
     taken again.
   - `hmac-sha256`: Standard Webhooks (standardwebhooks.com), under its own headers or Svix's
     (`svix-id`, `svix-timestamp`, `svix-signature`): `webhook-signature: v1,<base64>` (one or more)
     over `<webhook-id>.<webhook-timestamp>.<body>`, keyed by the secret's base64 key (`whsec_`
     optional), within 300 seconds of the arrival. The sender id is `webhook-id` and the type is the
     body's `type`.
   A signed id the database cannot keep (over 256 characters, spaces, or `body:`) becomes
   `sig:<signature>`. The 300 seconds are measured against the arrival, so a check that runs late
   judges the sender's clock against when the delivery came. A refusal's reason is a fixed phrase
   ("The Stripe signature does not match"); nothing from the delivery or the secret reaches a reason or
   a log. An item of a claim the broker cannot read is answered `retry`; a verdict it cannot record is
   counted, and the pass goes on (it stops after three).
3. `qorpera_finish_event_verification(authority, capability, delivery, claim, verdict, key, type,
   reason)`, broker role only, records the verdict when this claim still holds the delivery
   (otherwise `stale`, changing nothing):
   - `verified` with the sender id and the type, unless the hook was removed or its secret is gone
     since the claim: then the delivery is refused with that reason. If the hook's current secret is no
     longer the version the claim handed out (saved again, or replaced), the verdict is not taken: the
     delivery is offered again at once and checked with the current version (answer `retry`). A sender id is unique per hook
     among verified deliveries, as for address hooks; a second one becomes `duplicate` without its
     body. Each verdict is its own short transaction stamping `verified_at` with `clock_timestamp()`,
     as event wakes need (W2).
   - `refused` with the reason.
   - `retry` when the broker could not open the secret (a key this copy of the vault lacks, or a
     damaged envelope). The delivery is offered again after a minute, then five times longer after
     each attempt (1, 5, 25 and 125 minutes); the fifth attempt's retry refuses it ("The vault could not
     check it"), about two and a half hours after it arrived.
   A claim whose broker stopped expires after 60 seconds and counts as an attempt. A delivery the vault
   refuses keeps no body; one the purge refuses keeps it until the seven-day clear. The shared vault's due
   list takes the lowest company ids first when more than 1000 companies are due at once.

A delivery still `received` after 24 hours is refused by the purge ("Not verified in time").

## Event wakes (W2)

W2a (migration `20260928269290_runtime_event_wakes`, on today's routine rows per decision 6) and the
runtime side ship in one cut. Acceptance is contract section 21, item 33.

**The trigger.** A routine version may carry one listener trigger on a hook:
`{id, kind:'listener', source:'event', hookId, only?: [types], timeZone, replyPolicy?}`. `hookId` is
the hook's id in lowercase canonical form, so every reader compares it as text. `only` lists 1–20
distinct event types of printable ASCII without spaces, at most 128 characters each. A delivery
with no type matches only a trigger without `only`. As with file-change listeners, a listener is the
version's only trigger, and the hook must be a live hook of the routine's company and environment
(checked when the version is saved, by the agent's routine tool and by the version's activation). The
agent's tool compiles `{kind:"event", hookId, only?, timeZone, report?}` to it; `list_hooks` gives
the ids. In routine files (F2-6) this becomes `when: event`, `hook: <hook id>` and `only: [...]`, with
the file's `timezone` and `reply` keys. Member clients read the trigger (`CloudRoutineEventTrigger`):
the web routine list words it and offers pause and resume, and its editor does not edit it.

**Cursors.** Each event listener version gets a row in `qorpera_event_listener_cursors` with the
instant it became active. A resume or a new current version starts it again from now, as a file
listener does, so events that arrived while it was paused do not wake it. `taken_before` is the
listener's watermark: every matching verified delivery verified before it is taken or left behind, so
the waiting query starts there (or at the activation, or 7 days back, whichever is latest). The reader
moves it after each batch to the first delivery still waiting, and the drain moves it when nothing
matching waits (a filtered listener skipping other types); never closer than a minute to the clock,
so a receive still committing is never passed. W1b must therefore stamp `verified_at` with
`clock_timestamp()` in a transaction shorter than a minute.

**Admission.** The materializer's drain (`qorpera_drain_event_wakes`, called after the file drain)
takes up to 32 active cursors, oldest scan first, and for each one:
- skips it while its hook is removed, the company is paused, or the routine is not active at that
  version; it takes the routine row without waiting (a routine save takes it first) and skips the
  cursor when it is busy;
- skips it while one of the routine trigger's open event wakes is pending: queued, or materialized
  with its job queued or leased and nothing read (a finished run moves its wake on, so the open ones
  are few);
- otherwise, when a verified delivery of the hook since the cursor's start (within 7 days), matching
  `only` and not yet taken by this routine trigger, is waiting, inserts one occurrence: `wake_kind
  'routine'`, `source_kind 'event'`, `source_id` the hook, key `event:<routine version>:<trigger
  id>:<first delivery id>:<attempt>`, `scheduled_for` the first delivery's arrival, payload `{hookId,
  firstDeliveryId}`.
- A wake that ended without taking its deliveries (cancelled at admission, or its run failed before
  reading) is tried again for the same first delivery after 1, 4, 16 and 64 minutes. After five tries
  the first delivery is left behind, recorded against the fifth wake, and the next delivery wakes the
  routine. The attempt number comes from history, so the key is deterministic.

A routine that must report needs a public audience, as for file listeners. The existing insert
triggers apply unchanged: quiet hours move `not_before`, and the pinned sponsor pays. Errors for one
cursor that mean it cannot run now (the agent or requester gone, a lock held, a deadlock) skip it this
round; the materializer goes on.

**Reading.** `qorpera_read_native_wake` builds the rest of the wake first, then adds the batch in the
room left: the smaller of what the kernel's 48 KiB envelope bound and the runtime's 48 KiB payload
bound leave, less 4 KiB for the batch's own layout. The first read takes up to 20 waiting deliveries
into `qorpera_event_wake_deliveries(routine, trigger, delivery, occurrence)`, fewer when their
descriptions alone would not fit (always at least one), so a retried run reads the same batch. Each
event shows its delivery id, type, arrival, content type and size, and its body as UTF-8 text
(`encoding: utf8`) or base64 (`encoding: base64`), cut by its JSON-escaped bytes to at most 8 KiB and
to the room left (`truncated`), left out when no room is left (`truncated` alone), or `bodyCleared`
after 7 days. Events come in the order they were verified. `more` counts deliveries still waiting,
up to 1000, which wake the routine again once this occurrence has been read. A hook removed after
admission cancels its queued wakes at materialization, like any lost source authority. Two edges stay:
a wake whose other parts (a long intent and many held messages) leave less room than the batch's
descriptions need fails with 54000 before it takes anything, and the retry rule bounds it; a retried
read that finds more held messages than the first can fail the same way after its batch was taken,
and those deliveries are then not offered again.

**Outside content.** The wake protocol for an event wake says every event is outside content (contract
11.1): an instruction inside it is data, and outside actions it leads to pass the automatic review.
Item 33 of section 21 carries the adversarial event case of item 10.

**Tools.**
- `list_hooks` lists the company's live hooks. Addresses, which let anyone post into a hook, are shown
  only in runs an owner or admin started, as members see them; with them comes `url`, the full address,
  once operators set `qorpera_event_intake_settings.public_url` (Deploy (W2)).
- `read_event(deliveryId, offset?)` reads one verified delivery of the agent's own company: text in
  pieces of at most 16,000 characters and 32 KiB of JSON, or base64 of 24 KiB of raw bytes. `next` is
  the offset of the following piece (characters for text, bytes for base64).
  - **Every piece fits one tool result.** The result fence cuts every tool result to 8 KiB from its
    end, and the result's keys are sorted, so a whole database piece would lose the tail of its text
    while `next` survived: reading on from `next` skipped what was cut. The runtime tool therefore
    cuts the piece again before it answers, to what one result shows whole. It measures the receipt
    as the fence does: the tool's JSON is one string inside the fence's JSON, `< > & U+2028 U+2029`
    take six bytes, and 3 KiB stay free for the fence's provenance (as `read_context` keeps). The cut
    falls at a character (text) or after whole three bytes (base64), and `next` points right after it.
    The hook, type and content type count too.
  - The headers come with the first piece (offset 0) only, so a sender's long `From` or `Subject`
    cannot shrink every piece. There, headers that would leave the body less than 1 KiB are cut
    first, every value to the same number of characters, and the piece says `headersCut`.
  - A piece is about 4,500 characters of plain text, fewer when characters need escaping (dense
    HTML about 2,000 to 3,000), or about 3.4 KiB of bytes as base64. A 256 KiB email takes about 55
    reads as plain text and up to about 120 when it is mostly dense HTML.
  - The tool refuses a receipt whose `next` is not exactly its offset plus the piece it carries (code
    points for text, bytes for base64), or whose `done` contradicts `next`. The database's pieces
    hold to this; the SQL is unchanged.

Both are reads for the automatic review. Agents creating and removing hooks (`manage_hook`, W3,
reviewed as a new connection; a signed hook asks a member for its secret, connector `event_hook`,
secret name `h<hook id without hyphens>`) follows in a later step.

**Folder companies.** Event wakes of `folder-v2` companies are refused like their file-change wakes
until routine files (F2-6) and the folder's writer land. Whichever of W2 and F2-6 lands second lifts
the refusal and adds `event` to the routine file parser.

**The folder.** For `folder-v2` companies, once the core's writer lands (F1 C3), the platform saves each
verified delivery as `hooks/<hook name>/<yyyy-mm-dd>/<delivery id>.json` (the kept headers and the
body) in the same change set, and the wake names that path. Until then, and for today's companies, the
delivery row is the record, and agents save what they need.

## Deploy (W2)

The migration patches existing functions by exact text (trigger check, listener activation and sync,
`qorpera_manage_agent_routine`, the pin trigger, wake authority, the wake policy, the materializer,
the wake reader and the observation list); compare the anchors with master again before merging.
Roll the migration first, then a bundle with this runtime: until that runtime runs, no event routine
exists (older routine tools cannot write the trigger), and an older runtime refuses an event wake.
After it is live:

1. Set the public origin agents give senders:
   `update public.qorpera_event_intake_settings set public_url = '<supabase url>';` (the project's
   `https://` origin, no path).
2. Acceptance (section 21, item 33), with the intake switched on (Deploy (W1a) step 3): an agent sets
   up a routine with `{kind:"event", hookId}`, three posts to the hook wake it once, the run reads all
   three and one with `read_event`, and an event that tells the agent to do something outside its
   routine gains no authority.

## Mail (M2)

Email waking agents is the top priority after events (29 September), and a company's first address is on
a mail domain Qorpera owns (decision 7). Mail reuses the event machinery: a mailbox is a hook, a
received message is a delivery, and routines wake on it through the event trigger (W2).

**Provider.** Resend, which already sends the platform's invitations and hour notices. It receives
every message sent to a domain whose MX record points to it, parses it, and posts a signed
`email.received` webhook carrying only metadata; the body, headers and attachments' descriptions come
from its API (`GET /emails/receiving/{id}`) with the platform's key. The domain and the cost are Jonas's
call; until the domain exists, the build runs against Resend's `<id>.resend.app` receiving domain.

**Mailboxes (M2a).** An owner or admin creates one with `qorpera_create_company_mailbox`: a local part
(1–64 lowercase letters, digits, dots, hyphens and underscores; RFC 2142 names and `noreply` reserved)
on the platform's mail domain, and a purpose. An address belongs to one live mailbox across the
platform. The domain is one setting (`qorpera_mail_settings.domain`): a mailbox keeps only its local
part, so going live on the real domain is that one change plus its MX record, and every mailbox made on
the test domain moves with it. Each mailbox is a hook with the proof `mail`, named `mail-<local part>` (with a short digest when the
local part holds a dot or an underscore, which hook names cannot; hook names beginning `mail-` are
reserved for mailboxes), owned by the
platform: it has a random hook address that is never shown, and the public intake answers `unknown`
for it, so only the mail door fills it. Pausing, resuming and removing are the hook's; removing frees
the address. Members see the address (`email`) in the hook list. At most 20 mailboxes a company, within
its 50 hooks. `folder-v2` companies get mailboxes with their connection file, as hooks. Mailboxes do not
wait for N1: when founding gives companies handles, their first mailbox can be made from the handle.

**The mail door.** The Edge Function `mail-intake` checks the webhook's Standard Webhooks signature
(`svix-*` headers, five minutes' tolerance) with the platform's signing secret, which is an Edge Function
secret like the Resend key: mailboxes are the platform's, so no company vault is involved. It fetches the
message, writes it as JSON text (`qorpera.mail/v1`) and hands it in one call, with every recipient in To,
Cc, Bcc and the envelope, to `qorpera_receive_mail`. The database knows the domain: it looks up each
address on it and stores the message once in every live mailbox among them, as a verified delivery of
event type `mail.received`, content type JSON and key `mail:<provider message id>` (a retried webhook is
a duplicate and writes nothing). The text is stored as written, so its size is what the function
measured and its keys keep their order: subject, sender, recipients, reply-to, received time, message id,
In-Reply-To and References, whether it was sent automatically (M2b: the Auto-Submitted, Precedence and List-Id
headers, and `automated`, true for an Auto-Submitted other than `no`, a bulk, list, junk or auto-reply Precedence,
or a mailing list), the SPF, DKIM and DMARC results, the attachments' descriptions, then the text
and HTML bodies, cut to 256 KiB (HTML first, `truncated`). Text the database cannot hold (NUL, half a
surrogate pair) is cleaned first, and the recipient lists are bounded. The hook's minute and the company's
hourly budget apply as to any delivery. Mail for an address with no live mailbox, for a paused mailbox, or
that the provider no longer has is dropped. The door answers the provider 200 when every recipient is
settled, 429 with the longest `Retry-After` when a mailbox is over its limits, and 503 when mail is
switched off or something failed, so the provider retries; a message the database calls malformed is
logged and settled with 200, since a retry would send the same message.

**Agents.** A routine on a mailbox is an event routine on its hook: `{kind:"event", hookId}`, optionally
`only: ["mail.received"]`. The wake shows the message (cut to fit the wake), `read_event` reads it
whole, and `list_hooks` lists mailboxes with their addresses. Mail is outside content: the wake protocol
says so and names the authentication results.

**Sending (M2b).** An agent sends from a live mailbox of its company with the tool `send_mail`: `from` (the
mailbox's address as `list_hooks` shows it), `to` and `cc` (plain addresses, at most 10 together), a one-line
`subject`, plain `text` of at most 20,000 characters, and optionally `inReplyTo`, the deliveryId of a received
email it answers. Every email is an outside action to the automatic review, which sees the recipients, sender,
subject and text; workers have no `send_mail`, and the wake must allow work (acknowledged, the company neither
paused nor being deleted, no final answer yet). The service-role `qorpera_send_agent_mail` checks the request
again, finds the mailbox (live, of the run's company and environment, not paused) and queues the email in
`qorpera_company_mail_outbox`, keyed by the run and the tool call, so the same call again is the same email:

- From the agent, as recipients read it: the name `<agent> at <company>` (quotes, brackets, line breaks and
  invisible format characters such as bidi controls removed) at the mailbox's address.
- The AI line: the text's last paragraph is `Written and sent by <agent>, an AI agent working for <company>.` The
  database adds it; no agent can leave it out. It is not placed after a signature separator, which clients dim.
- Never as if from Qorpera (founder decision, 1 October 2026; `20260928319810`): a send is refused (42501) when the
  agent's name, the company's name or the mailbox's local part reads as Qorpera however it is spelled (case,
  separators, accents, full width, look-alike Cyrillic or Greek letters and digits), and no mailbox is created
  with such a name (22023). Names are not refused where they are set; the check guards the From line.
- A reply to a received email of the company (`mail.received`, verified) carries that email's thread:
  `In-Reply-To` its message id, and `References` the thread's first id and its newest ids that fit one header line
  (980 characters, RFC 5322 3.6.4). An email whose text was cleared (after 7 days), or without a usable message
  id, is answered outside its thread.
- Mail loops: an email the mail door marked `automated` (an auto-reply, a mailing list, bulk mail) is never
  answered (42501); every reply carries `Auto-Submitted: auto-replied` (RFC 3834), so other responders, another
  company's agents included, leave it unanswered; and a company never emails its own mailboxes (42501), whose
  routines would answer it. Another company's mailbox is a recipient like any other.
- Limits: sending has its own switch (`qorpera_mail_settings.sending`, built off; `enabled` must be on too), and
  a company emails at most `company_hourly_recipients` (60) recipients an hour and `company_daily_recipients`
  (300) a day, each address of an email counting once, under one lock per company. Email cancelled before any
  attempt does not count; email attempted counts, since it may have gone out. Past a limit the tool says, to the
  second, when this email can go; an email with more recipients than a limit allows never fits. Every company
  sends from the platform's domain, so one company's spam would hurt all of them: these are the guard until
  reputation tracking.

The Edge Function `mail-outbox`, called each minute by pg_cron + pg_net with a Supabase secret key (like the hour
notices), claims up to 10 emails with `qorpera_claim_company_mail` under a five-minute lease and sends each
through Resend's `POST /emails` with the platform's key, which no node, guest or agent holds, 0.6 seconds apart:
plain text and the headers above, from the mailbox's address as it was at the email's first attempt (a domain
change moves email not yet attempted; one already attempted repeats its address). The idempotency key is
`company-mail/<email id>`, so a send repeated after a lost answer or an expired lease is the same email. A
timeout, rate limit or server error is retried after 1, 2, 4 ... minutes, at most eight attempts; any other
refusal fails the email (`qorpera_complete_company_mail`, `qorpera_fail_company_mail`). The claim cancels email
from a removed or paused mailbox or of a company being deleted, fails email not sent within a day, and clears
texts seven days after they settle, keeping the receipt; an email already attempted says it may have gone out.
Switched off, the claim sends nothing and queued email waits; the first claim after sending is switched on again
fails what waited more than a day. Texts are cleared only by the claim, so unscheduling the worker stops that too.
Agents learn an email was queued, not that it arrived; bounces and complaints, and a sent-mail view, follow.

**Plus addresses and find_mail** (migration `20260928429982_runtime_company_mail_find_and_tags`, agreed with A1 on 2
October, for accounts the company owns).
- **Plus addresses.** `local+tag@<mail domain>` reaches the mailbox `local@`, so an agent can open a second account
  on one site (`agents+stripe@`). The tag is lowercase letters, digits, dots, hyphens and underscores, and the whole
  local part, tag included, is at most 64 characters (the mail door's limit); any other tag reaches no mailbox
  (`unknown`). A message to several tags of one mailbox is stored once. Plus addresses
  only receive: `send_mail` sends from a mailbox's own address, and refuses a company's own mailboxes as recipients
  with or without a tag.
- **What a mail delivery keeps.** Each received mail's delivery now records in `headers`:
  - `delivered-to`: the message's recipients that reach that mailbox, tags included, whole addresses up to 2048 bytes;
  - `from` and `subject`: control characters become spaces, at most 998 characters, cut further to 2048 bytes of JSON;
  - `authentication-results`: the mail door's verdicts, `spf=… dkim=… dmarc=…`.

  So the headers always fit their 8 KiB check. They count toward the company's hourly byte budget with the body
  (contract item 3), and are cleared with the body after 7 days. Mail received before the migration keeps none.
- **`find_mail`.** An agent searches its company's received mail (`qorpera_find_agent_mail`, through the run
  binding like `read_event`), with these filters:
  - `mailbox`: its address, which must be one of the company's;
  - `to`: an address the mail was delivered to, tag included;
  - `from` and `subject`: parts of them, in any case;
  - `since`: an instant with its offset; by default the last 24 hours, never more than 7 days back;
  - `before`: an instant with its offset, to page back.

  It returns up to 10, newest first, as many as fit the tool's 8 KiB answer (about 6000 bytes of mails). Each has
  `deliveryId`, `mailbox`, up to 5 `deliveredTo`, `from` and `subject` (200 characters each), `authentication` and
  `receivedAt`. `more` is true when there are other matches, or when the search reached its bound: it looks at the
  newest 2000 mails in the window (one ordered index scan per mailbox, planned with that mailbox's own values and
  stopping at 2000 rows, whatever the company's volume) and reads only the kept headers. `nextBefore` is the `before` that shows the next older ones,
  even when a page shows none. The answer's size counts the escaping it gets inside the tool's 8 KiB. It returns no mail text and matches nothing
  inside it; the agent reads a mail with `read_event`. With `waitSeconds` (up to 120) the runtime asks again every 3
  seconds until a match arrives. It is a read for the automatic review.
- **Deploy.** The migration patches `qorpera_receive_mail`, `qorpera_send_agent_mail` and
  `qorpera_record_runtime_observation` by exact text, and adds `qorpera_find_agent_mail` to G2-1's native host
  allowlist. It rolls with a bundle carrying this runtime: an older runtime has no `find_mail`. Received mail now
  records its headers and counts their bytes, tagged or not; nothing else changes for untagged mail. Acceptance: the
  company's account row is opened first (A1-4 opens it before the address is typed into any form, email-first and
  magic-link sign-ups included, so the first code is already account mail); an agent then signs a test company up
  on a site with `agents+<site>@`, waits with `find_mail` for the confirmation and reads it with `read_event`.

**Founder decisions (1 October 2026).** The AI line stays as written, as its own last paragraph on every email.
`Auto-Submitted` goes only on automatic replies, the loop guard, and never on new emails, so help desks do not drop
them. No email looks like it comes from Qorpera (above).

**Attachments (M2c-1)** (migration `20260928429984_runtime_company_mail_attachments`; Jonas, 2 October: agents send
and receive files by mail, and a received attachment is fetched when an agent saves it, not when the mail arrives).
- **Received.** The mail door keeps each attachment's description (`id`, `filename`, `contentType`, `size`); the
  provider keeps the bytes for 30 days, and its download addresses last an hour. An agent saves one into the company
  folder with `save_attachment`: `deliveryId`, `attachment` (its place in the email's list, from 1), and `path`,
  `operationKey` and `expectedVersion` as for `company_write`.
  - The first request (`qorpera_native_mail_attachment`, through the run binding like `read_event`) records a fetch
    in `qorpera_mail_attachment_fetches`, one per received email and attachment, and calls the Edge Function
    `mail-attachments` at once through `pg_net` (each minute through `pg_cron` too).
  - The function claims a few fetches under a five-minute lease, asks the provider where each attachment is (its
    received-attachments list, with the platform's key), streams it, and stores it as the company's objects: 4 MiB
    chunks named by their sha256 in the Storage bucket `qorpera-profile-objects`. The catalog records each chunk, and
    the company's storage allowance counts it. The fetch completes with the file's digest, size and chunks; the
    database checks each chunk is the company's object of its size.
  - The runtime waits up to 90 seconds, asking every 2. Once stored, it reads the chunks through the object gateway
    (each against its digest, the whole against the file's) and writes them as a company file through the path
    gateway, as `company_write` does: the agent's authority, the version check, protected paths as proposals, and a
    receipt. A second save of the same attachment reuses its bytes. If the fetch is still running when the wait
    ends, the agent calls again with the same arguments.
  - A failure that may pass (a timeout, a rate limit, a server error) is tried again after 1, 2, 4 ... minutes, up to
    six attempts or a day. An attachment the provider no longer has, one over 40 MiB, one whose size differs from what
    the provider announced, or an allowance used up fails at once. The agent learns why, in fixed words (an
    exception's own text can carry the signed download address). A failed fetch is tried afresh when an agent asks
    again ten minutes later, while the email's text is kept.
  - Limits: 40 MiB an attachment, while the email's text is kept (7 days). Nothing is stored that no agent saved.
  - Reading: `company_read` reads text files. A PDF, an image or an office file opens on a computer
    (`computer_transfer`).
- **Sent.** `send_mail` takes `attachments`: up to 10 company file paths the agent may read, at most 28 MiB in all
  (40 MB once encoded, the provider's limit). The database checks each through the Company File authority every file
  tool uses (`qorpera_company_path_actor`, `qorpera_company_path_remember_read`), records each as it is when queued
  (path, version, manifest, digest, size) and lists them on the receipt and the review card. A file name over 255
  characters is refused. `mail-outbox` reads each
  file's manifest and chunks from the company's objects in Storage, where the object gateway copies every object,
  checks them against their digests, and sends them as the email's attachments. A file not in Storage yet is tried
  again later. A claim takes due emails in order while their attachments come to 28 MiB, one email's worth, and the
  sender turns each file into base64 as it reads it, so one call stays within an Edge Function's memory (256 MB) and
  time. `mail-attachments` claims one fetch a call, for the same reason.
- **folder-v2.** Refused both ways (`0A000`) until the folder-v2 core adds mail attachments as a GC root (C1d). No
  production company uses folder-v2 today.

**Members read mail (I5a)** (migration `20260928439980_runtime_company_mail_member_read`; shapes agreed with the
Interfaces session on 2 October for the Mailbox, `RUNTIME-INTERFACES.md` §4, sources `mail` and `mail_addresses`).
- **Threads.** A thread's id is base64url (no padding) of sha-256 over `<mailbox id>:<key>`: 43 characters, safe in a
  URL and a path, never the raw header, and the same after the text is cleared.
  - A received message's key is its thread's root Message-ID: the first id it references, else the one it answers,
    else its own (Message-IDs as RFC 5322 writes them: printable ASCII in angle brackets, no quotes or backslashes).
  - What a received message needs for 30 days lives in `qorpera_mail_received`, apart from the delivery's headers
    and body, which the deliveries' purge clears after 7: its thread, Message-ID, sender, subject, recipients,
    `delivered-to`, the sender's authentication, `automated`, its attachments' descriptions and its account mark. The
    delivery's headers are unchanged.
  - An agent's reply joins the received email's thread. An email an agent starts begins one (`mail:<id>`).
    `mail-outbox` reads back the provider's Message-ID of what it sent (Resend's sent-email API, best effort; those
    never asked first, the newest first, each asked again after five minutes for a day), so an answer to that email
    arriving at the same mailbox joins its thread.
  - Mail without ids, and mail received before the migration, is a thread of its own (`delivery:<id>`).
  - `qorpera_mail_threads` indexes them: the newest message's subject, the outside party (the newest received
    message's sender, else the first recipient of an email an agent started), the last message and its direction,
    who last replied, the number of messages. The mail door and `send_mail` keep it; the outbox's claim deletes threads
    quiet for 30 days, with the members' read marks (`qorpera_mail_thread_reads`).
- **The members' calls** (authenticated; any member of the company; membership checked with a plain read before
  anything else; no lock; empty while mail is off):
  - `qorpera_member_mail_addresses(environment)`: the live mailboxes with `status`, the routines that listen on each
    (`routines`, with their agents in `handledBy`) and `last7Days`.
  - `qorpera_member_mail_threads(environment, {address?, state?, before?, limit ≤ 50})`: threads newest first with
    `thread, address, fromName, fromAddress, subject, lastAt, state, handledBy, direction, unread, messages`.
    `state` is `waiting` (an open send_mail review card answers it), `handled` (a reply that has not failed or been
    cancelled followed the newest received message, or nothing was received) or `new`. `handledBy` is the last replier, else the agent whose
    routine woke on the newest received message. `nextBefore` is `{lastAt, thread}`. An address filter takes a
    mailbox's address, a +tag included; a state filter looks at the newest 2000 threads a page.
  - `qorpera_member_mail_thread(environment, thread)`: the newest 50 messages, oldest first. Received ones have the
    sender, `to`, `cc`, subject, text (cut to 16,000 characters while kept, `textCleared` after), the SPF, DKIM and
    DMARC results, `automated` and the attachments' descriptions. Sent ones have the agent, status, text while kept
    and the attached files. `waiting` lists the open send_mail cards that answer the thread, with their arguments;
    the Mailbox's Send answers the card through the existing review answer.
  - `qorpera_member_mail_waiting(environment)`: every open send_mail card, a new email without a thread too.
  - `qorpera_mark_mail_thread_read(environment, thread)`: the member's read mark; a newer received message makes the
    thread unread again.
- **Account mail.** Mail to an address a company account signs in with (A1's `qorpera_company_account_mail`, called
  with the mailbox's own company and environment once it exists) shows `account` (who used it and when), never its
  subject, text, recipients or attachments. It is decided when the mail arrives (its subject is not kept, and its
  thread stays marked) and asked again when it is read. A company being deleted has no members to read its mail.

**Next (M2c-2).** Threads and sent mail as files in the folder (`mail/<address>/`, sent mail beside the received;
Jonas, 2 October, Interfaces decision 3), once the folder's platform writer lands. A connected Gmail read once a
minute can become deliveries the same way.

## Deploy (M2c-1)

The migration adds a table and six functions, and patches `qorpera_send_agent_mail`, `qorpera_agent_mail_receipt`,
`qorpera_claim_company_mail` and `qorpera_record_runtime_observation` by exact text. It rolls with a bundle carrying
this runtime: an older runtime has no `save_attachment` and sends no `attachments`.

The functions go first. The old `mail-outbox` ignores a claimed email's files and would send it without them, and a
fetch nobody serves is given up after a day. The new `mail-outbox` reads the old claim's shape too, and
`mail-attachments` only answers 503 until the migration exists. In order:

1. `pg_net` must be installed (`create extension if not exists pg_net`; production had none on 2 October). The outbox's
   timer (M2b) needs it too.
2. Deploy the functions: `supabase functions deploy mail-outbox` (it now sends attachments) and
   `supabase functions deploy mail-attachments` (`verify_jwt = false`, reads `RESEND_API_KEY`).
3. Apply the migration with its bundle.
4. Schedule the fetch worker each minute, as the outbox (same Vault entries: `qorpera_project_url` and
   `qorpera_mail_outbox_key`; the database's immediate call uses them too):

   ```sql
   select cron.schedule('qorpera-mail-attachments', '* * * * *', $$
   	select net.http_post(
   		url := (select decrypted_secret from vault.decrypted_secrets where name = 'qorpera_project_url')
   			|| '/functions/v1/mail-attachments',
   		headers := jsonb_build_object('content-type', 'application/json',
   			'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'qorpera_mail_outbox_key')),
   		body := '{}'::jsonb,
   		timeout_milliseconds := 120000)
   $$);
   ```

5. Watch by count: `select status, count(*) from public.qorpera_mail_attachment_fetches group by 1 order by 1`.
6. Acceptance: an email with a PDF and a CSV arrives at a test mailbox; the routine saves both with `save_attachment`;
   the CSV reads with `company_read`; the PDF opens on a computer. The agent answers with `send_mail` attaching a
   company file, and the reply arrives with the file intact (same digest). Then a 28 MiB attachment both ways: received
   and saved, then sent, with the functions' logs showing no resource error.

## Deploy (I5a)

The migration adds three tables, member calls and indexes (one on `qorpera_action_reviews` for open send_mail cards),
backfills the last 30 days' mail through the same rules as live mail (about 4 s for 6,000 mails; it holds the mail door's, review cards' and outbox's locks until it commits, so deploy it at a quiet time), and patches `qorpera_receive_mail`,
`qorpera_send_agent_mail` and `qorpera_claim_company_mail` by exact text (after M2c-1's patches). No runtime change. Deploy `mail-outbox` before or with the migration: it reads back Message-IDs through
`qorpera_company_mail_message_ids_due`, and an older one simply leaves them unknown. Acceptance: a member opens the
Mailbox and sees a received email, the agent's reply in its thread, a waiting send, and an account email without its
code.

## Deploy (M2a)

The migration adds tables and functions, and patches four existing ones by exact text: the intake door
(`qorpera_receive_event`: a mailbox's hook is unknown), the hook descriptor (a mailbox shows `email`,
never its hook address), the agents' hook list (no `url` for a mailbox) and hook creation
(`qorpera_create_event_hook`: names beginning `mail-` are the mailboxes'; production had none when this
was written). It rolls: nothing uses mailboxes before they exist. After it is live:

1. Deploy the function: `supabase functions deploy mail-intake` (`verify_jwt = false`), with the secret
   `RESEND_WEBHOOK_SECRET` (the webhook's signing secret, `whsec_…`); `RESEND_API_KEY` is already set.
2. In Resend: add the receiving domain (or use the `<id>.resend.app` one for acceptance), and a webhook for
   `email.received` to `<supabase url>/functions/v1/mail-intake`.
3. Set the domain and switch mail on:
   `update public.qorpera_mail_settings set domain = '<receiving domain>', enabled = true;`
4. Acceptance: an owner creates a mailbox on a test company; an agent sets up a routine on its hook; an
   email sent to the address wakes it, and the run reads the message.

## Deploy (M2b)

The migration adds a table and functions, three setting columns, and patches one existing function by exact text
(the observation list names `send_mail`). It rolls with a bundle carrying this runtime: an older runtime has no
`send_mail`, and nothing sends while sending is off. The mail door (`mail-intake`) is redeployed too: it now marks
mail sent automatically. After it is live:

1. In Resend (Jonas): verify the mail domain for sending (its SPF and DKIM records), the same domain mailboxes
   receive on. Until then Resend refuses the platform's `from`, and the outbox fails those emails.
2. Deploy the functions: `supabase functions deploy mail-outbox` (`verify_jwt = false`) and
   `supabase functions deploy mail-intake`. They read the Edge Function secrets `RESEND_API_KEY` and (the intake)
   `RESEND_WEBHOOK_SECRET`, which Jonas sets; production had neither on 2 October.
3. Schedule it every minute, with the project URL and a Supabase secret key from Vault as for the hour notices
   (`RUNTIME-COMPUTER-HOURS.md`, "Email"; a key made for this worker, e.g. `qorpera_mail_outbox_key`, keeps its
   rotation separate):

   ```sql
   select cron.schedule('qorpera-mail-outbox', '* * * * *', $$
   	select net.http_post(
   		url := (select decrypted_secret from vault.decrypted_secrets where name = 'qorpera_project_url')
   			|| '/functions/v1/mail-outbox',
   		headers := jsonb_build_object('content-type', 'application/json',
   			'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'qorpera_mail_outbox_key')),
   		body := '{}'::jsonb,
   		-- A paced batch takes up to about 110 seconds; pg_net's default is 5.
   		timeout_milliseconds := 120000)
   $$);
   ```

4. Switch sending on: `update public.qorpera_mail_settings set sending = true;` (mail `enabled` and the domain
   are M2a's).
5. Watch by count: `select status, count(*) from public.qorpera_company_mail_outbox group by 1 order by 1`.
6. Acceptance: a routine on a mailbox wakes on an email from an outside address and answers it with `send_mail`
   and `inReplyTo`; the answer arrives from `<agent> at <company>` at the mailbox's address, ends with the AI line,
   sits in the sender's thread and carries `Auto-Submitted: auto-replied`, with `References` unfolded or folded
   correctly; the sender's reply wakes the routine again; an out-of-office answer to it arrives `automated` and is
   not answered.
7. Off again: `update public.qorpera_mail_settings set sending = false;` (queued email waits, and fails if it
   waited a day once sending is back), or `select cron.unschedule('qorpera-mail-outbox')`, which also stops the
   seven-day clearing of sent texts.

## Deploy (W1b)

The migration adds five columns and a partial index to `qorpera_event_deliveries`, two helper functions, a
trigger on the hooks' status and the broker's three functions, and patches three existing functions by exact
text: `qorpera_create_event_hook` (signed proofs are allowed), `qorpera_event_hook_descriptor`
(`signingSecret`) and `qorpera_receive_event` (a signed delivery is stored as `received`). No Edge Function
changes: the intake already keeps the Standard Webhooks and Svix headers. Before merging, compare the anchors
with master again (RUNTIME-RELEASE-TRAIN.md).

1. Apply the migration. Until the brokers run the new build, signed deliveries wait as `received`, and the
   purge refuses them after 24 hours.
2. Roll the broker build carrying this runtime (`node scripts/package-cloud-secret-broker.mjs`) to the shared
   vault (node 1 and node 2's standby) and to every company broker unit still running, after the migration: a
   build that runs before it logs an error line every five seconds ("Event verification: a pass stopped on an
   error" from a company broker, "Shared vault: a background pass failed" from the shared vault).
3. Check by count: `select status, count(*) from public.qorpera_event_deliveries where received_at > now() -
   interval '1 day' group by 1`. Nothing should stay `received` for more than a few seconds. `journalctl -u
   <unit>` logs a count line only when a pass refused, retried, found a stale claim or could not record a
   verdict.
4. Acceptance on a test company:
   - An owner creates a `github` hook, saves a secret through the capture, and points a repository webhook
     (content type JSON) at the hook's address with the same secret. The ping and an opened issue arrive
     `verified` with types `ping` and `issues.opened` and a `sig:` sender id. A redelivery from GitHub's page
     becomes `duplicate`. A webhook with a different secret is `refused` ("The GitHub signature does not
     match"). A routine listening on the hook wakes on the issue (W2).
   - An `hmac-sha256` hook takes a delivery signed with a Standard Webhooks library (`new Webhook(secret)
     .sign(id, timestamp, body)`), keyed by its `webhook-id`.
   - Removing the hook revokes its secret.

## Deploy (W1a)

The migration adds tables and functions that nothing calls yet, and patches `qorpera_folder_enable`
(operator-only) by exact text so it also refuses a company with hooks, a condition that cannot hold
before the migration. It is safe for both bundles during a roll. Before merging, compare the patch's
anchor with master again (RUNTIME-RELEASE-TRAIN.md). After it is live:

1. Deploy the function: `supabase functions deploy event-intake` (`verify_jwt = false` in
   `supabase/config.toml`). It needs only `SUPABASE_URL` and the service key the platform provides.
   Until the switch is on it answers every delivery that reaches the database, a POST to a
   well-formed address, 503 ("Events are unavailable right now"), before looking the address up. The
   function's own answers (405, 413, 431) come first either way. A path that is not a 43-character
   address gets 404 ("This is not a hook address") from the function itself, by its shape alone;
   an address with no live hook gets 404 ("No hook has this address") once the switch is on.
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
- Duplicates are decided after verification, so a forged early copy cannot suppress a real event; a
  signed hook's sender id is always covered by the signature (W1b), so a replay cannot take a coming
  event's id either.
- Limits bound storage: at most `per_minute × max_body_bytes` a minute per hook (30 MiB at the
  maximums), the company's hourly budget across all its hooks (64 MiB by default), and the platform
  switch. Refused requests write nothing.
- A company being deleted stops receiving at once (`unknown`). The company purge removes its hooks and
  deliveries with the company (foreign keys cascade; test 730 runs the purge). Its usage rows hold
  only counts and expire within a day.
- No table is readable by `anon`, `authenticated` or the broker role. Members read through the
  listed functions, and the broker reads only through its claim and finish functions (W1b), each
  checking the broker authority's capability and confined to that authority's company, and the shared
  vault's due list, which checks the principal's capability and names only its own companies.
- A hook's signing secret is opened only in the memory of the broker that serves its company. The
  database hands the broker the sealed envelope and receives back a verdict: a sender id, a type or a
  fixed reason. A secret sealed for another authority is refused, not retried.
