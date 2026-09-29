# Event intake and event wakes

Founder decisions of 29 September 2026, on the Q1 page "Qorpera on Qorpera"
(https://claude.ai/artifact/J9rKxZmibyRFazntBPBbsh), relayed by the coordinator:

- Agents must wake on defined events, such as incoming email and webhooks from any service. This
  is the base for routines and the top priority of workstream Q1.
- Event wakes also come to today's routine rows before the clean reset (decision 6), as the one
  exception to "old paths are frozen". Routine files (F2-6) take the same trigger.
- Agents act through the company's own accounts, and credentials live in the vault (decision 2).
- A company's first address is on a mail domain Qorpera owns (decision 7). Mail arrives through this
  same intake (step M2).

Contract: section 16.3 and the 2026-09-29 amendment "events wake agents" (section 19). This file is
the technical design. The Q1 page is the plain one.

Status: design, and build step W1a in progress. W1a takes migration slot
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
| `name` | handle, `^[a-z][a-z0-9-]{0,63}$`, unique among the company's hooks that are not removed |
| `purpose` | one line, 1–512 characters |
| `proof` | `address`, `stripe`, `github` or `hmac-sha256` |
| `address` | 43 characters of base64url from 32 random bytes, unique |
| `status` | `active`, `paused` or `removed` |
| `max_body_bytes` | 1 KiB to 1 MiB, default 256 KiB |
| `per_minute` | deliveries accepted per rolling minute, 1–600, default 120 |
| `created_by_user_id` / `created_by_staff_agent_id` | who made it (exactly one; agents from W2) |
| counters | `received_count`, `refused_count`, `last_received_at` |

A company has at most 50 hooks that are not removed.

**Proof.**
- `address`: whoever knows the address may post. The address works like a key that only lets
  someone post events into this hook, and nothing else. The platform shows it to the company's owners
  and admins, and to agents that manage hooks (W2). It is not a vault secret: holding it grants no
  access to any service or company data, and every event is outside content anyway (below). Use it
  for senders that cannot sign, such as a website form.
- `stripe`, `github`, `hmac-sha256`: the sender signs each delivery with a shared secret. The secret
  is a company vault secret with connector `event_hook` and the hook's name as its secret name,
  captured through the existing vault capture (`qorpera_begin_cloud_secret_capture`). Agents never see
  it. Until that secret exists the hook refuses deliveries (`not_ready`, HTTP 409). Removing a hook
  leaves its secret in the vault; a new hook with the same name uses it.

**Who manages hooks (W1a).** Owners and admins, through
`qorpera_create_event_hook`, `qorpera_set_event_hook_status` and `qorpera_list_event_hooks`.
Contributors and viewers see names, proof and status, not addresses. From W2, an agent creates,
pauses and removes hooks with `manage_hook`, and creating one passes the automatic review as a new
connection. The Settings split (step A3) lists hooks under Company connections.

## Deliveries

Table `qorpera_event_deliveries`:

| Column | Meaning |
| --- | --- |
| `id` | uuid, the delivery id agents see |
| `hook_id`, `profile_id` | the hook and its company |
| `received_at` | when the intake took it |
| `status` | `received` (waits for the vault), `verified`, `refused` or `duplicate` |
| `delivery_key` | the sender's own id once verified: Stripe's `evt_…`, GitHub's `X-GitHub-Delivery`, or `X-Qorpera-Delivery` / `Idempotency-Key`, otherwise the body's SHA-256 |
| `event_type` | Stripe's `type`, GitHub's `X-GitHub-Event` (with `.action` when the body has one), `X-Qorpera-Event`, or null |
| `content_type`, `headers` | the content type, and an allowed list of headers (below), at most 8 KiB |
| `body`, `body_sha256`, `body_bytes` | the raw body; the body is cleared after 7 days, the rest kept 30 days |
| `verified_at`, `reason` | when it was verified, or why it was refused (at most 500 characters) |

- **Kept headers:** `content-type`, `user-agent`, `stripe-signature`, `x-hub-signature-256`,
  `x-github-event`, `x-github-delivery`, `x-github-hook-id`, `x-qorpera-signature`,
  `x-qorpera-timestamp`, `x-qorpera-delivery`, `x-qorpera-event`, `idempotency-key`, and the Standard
  Webhooks and Svix headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`, `svix-id`,
  `svix-timestamp`, `svix-signature`) for mail providers (M2). Everything else, including
  `authorization` and cookies, is dropped by the function.
- **Duplicates.** A verified delivery is unique on `(hook_id, delivery_key)` among verified
  deliveries of the last 30 days. A later copy is recorded as `duplicate` and answered 200, so the
  sender stops retrying. Deduplication runs only after verification. Otherwise someone who knows an
  address could send a fake delivery with a real event's id ahead of it and have the real one dropped.
- **Rate.** At most `per_minute` deliveries per hook in any rolling 60 seconds are accepted. Extra ones
  are refused with 429 and counted, and are not stored. The hook row is locked for each receive, so
  the count is exact and receives on one hook are serialized.
- **Size.** The function refuses a body over 1 MiB before reading it (`Content-Length`) or while
  reading it (a stream cap). The database refuses a body over the hook's `max_body_bytes` (413).
- **Retention.** `qorpera_purge_event_deliveries(limit)` clears bodies after 7 days and deletes rows
  after 30. The coordinator schedules it (pg_cron, hourly). The event itself stays in the company
  folder (below).

**Answers.**

| Outcome | HTTP | When |
| --- | --- | --- |
| `accepted` | 202 | stored; for an address-proven hook, also verified |
| `duplicate` | 200 | an address-proven delivery whose key was already verified |
| `unknown` | 404 | no hook has this address, or it was removed, or its company is being deleted |
| `paused` | 409 | the hook is paused |
| `not_ready` | 409 | a signed hook whose secret is not in the vault yet |
| `too_large` | 413 | over the hook's limit |
| `limited` | 429 | over `per_minute`, with `Retry-After: 60` |
| database unreachable | 503 | the sender retries |

A signed delivery is answered 202 when it is stored, before the vault checks it. A bad signature is
therefore not reported to the sender. It is recorded as `refused` with the reason, and counted on the
hook.

## Verification in the vault (W1b)

Every broker, both the per-company brokers and the shared vault, runs a verification loop for the
companies it serves:

1. `qorpera_claim_event_verifications(authority, capability, limit)` claims up to 32 `received`
   deliveries of its companies for 60 seconds. For each it returns the body, the kept headers, the
   hook's proof, and the current version of the `event_hook` secret (key id and envelope).
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

**The trigger.** A routine version may carry one listener trigger on a hook:
`{kind:'listener', source:'event', hookId, only?: [types], timeZone, replyPolicy}`. `only` lists at
most 20 event types of at most 128 characters each. A delivery with no type matches only a trigger
without `only`. As with file-change listeners, a listener is the version's only trigger. In routine
files (F2-6) this is `when: event`, `source: hooks/<name>` and `only: [...]`.

**Admission.** When a delivery becomes verified, the same transaction looks for active routines on
the hook whose trigger matches. For each one:
- if no event occurrence of that routine's trigger is still queued, it inserts one: `wake_kind
  'routine'`, a new `source_kind 'event'`, `source_id` the hook, key `event:<routine version>:<trigger
  id>:<delivery id>`, payload `{hookId, deliveryId}`;
- if one is queued, nothing is inserted: the queued occurrence collects the new delivery when it is
  read.

So a burst of deliveries becomes one wake. The existing insert triggers apply unchanged: quiet hours
move `not_before`, a paused company cancels the occurrence, and the pinned sponsor pays.

**Reading.** `qorpera_read_native_wake` for an `event` occurrence takes, the first time, up to 20
verified deliveries of that hook and trigger that no earlier occurrence took. It records them in
`qorpera_event_wake_deliveries(occurrence_id, delivery_id)`, so a retried run reads the same batch. The
payload lists each one: id, type, received time, content type, and the body as UTF-8 text up to 16 KiB
(`truncated: true` beyond that), with at most 64 KiB of bodies in total. Deliveries left over wake the
routine again as soon as this occurrence ends.

**Outside content.** Every event is outside content (contract 11.1). The wake protocol tells the agent
that an instruction inside an event is data, never an instruction, and outside actions it leads to
still pass the automatic review. The adversarial test of 11.1 gains an event case.

**Tools.**
- `read_event(deliveryId, offset?)` returns a delivery's body in 64 KiB pieces, for the agent's own
  company only.
- `manage_hook(action: list|create|pause|resume|remove, …)` lets an agent manage hooks. Creating a
  signed hook returns its address and asks a member for the signing secret with a secret card
  (connector `event_hook`, secret name = the hook's name).

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

The migration only adds tables and functions that nothing calls yet, so it is safe for both bundles
during a roll. After it is live:

1. Deploy the function: `supabase functions deploy event-intake` (`verify_jwt = false` in
   `supabase/config.toml`). It needs only `SUPABASE_URL` and the service key the platform provides.
2. Schedule retention:
   `select cron.schedule('qorpera-event-deliveries-purge', '17 * * * *',
   $$select public.qorpera_purge_event_deliveries(10000)$$);`
3. Acceptance: an owner creates an address-proven hook on a test company, posts to
   `<supabase url>/functions/v1/event-intake/<address>` with `curl`, and sees the delivery with
   `qorpera_list_event_deliveries` (202 `accepted`, then 200 `duplicate` for the same
   `X-Qorpera-Delivery`, and 404 after removing the hook).

## Security

- The intake holds no company secret and no user session. It can only add deliveries to hooks that
  exist.
- A hook's address grants only posting into that hook. Deliveries wake agents only after the proof
  holds, and their content is outside content.
- Duplicates are decided after verification, so a forged early copy cannot suppress a real event.
- Limits bound storage per hook: at most `per_minute × max_body_bytes` a minute, and at most 50 hooks
  per company.
- A company being deleted stops receiving at once (`unknown`). The purge removes its hooks and
  deliveries with the company (foreign keys cascade).
- No table is readable by `anon`, `authenticated` or the broker role. Members read through the
  listed functions, and the broker reads only through its two functions (W1b).
