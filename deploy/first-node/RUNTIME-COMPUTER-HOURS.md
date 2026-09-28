# Computer hours (billing of machine time)

Founder approval: 28 September 2026, page "Computer Hours"
(https://claude.ai/artifact/Y2kYvCnpqXDaqHnNkCjhBi), all eight choices as recommended, on top of
the decisions recorded when draft PR #326 was closed. Contract: section 19, 2026-09-28 amendment
"computer hours". This file is the technical design; the page is the plain one.

Status: design. Build step 2 (measuring) takes migration slot
`20260928248000_runtime_computer_hours_meter`.
Later steps fix their own names in their migrations and in `supabase/CLIENT-CONTRACT.md`. Names
marked "not on master yet" come from open work.

## Decisions

Fixed on 28 September (the #326 audit):
- The name is "computer hours". What is billed is machine time. A company machine hosts its
  configured number of computers (six is the target). Every machine kind counts: company machines,
  agents' machines, coding machines and run boxes.
- Hours are pooled across the co-founders' plans. The company can also buy credits with any card
  a founder picks. Members who are not founders are never billed personally.
- Every company gets 5 free computer hours. No payment to found a company.
- Billing email goes to the card owner who bought the credits, or to the founders whose plan was
  used.
- Only the last member may delete a company (built by the membership work, S2).

Chosen on the page (recommended option each time):
1. A machine counts by size: 1 hour per hour for a standard machine (4 vCPU, 8 GiB), by the larger
   of its CPU and memory ratio.
2. The 5 free hours are used first by every company, whether or not a founder pays.
3. Founders' plans pay before company credits.
4. Plans are shared evenly between the founders who still have hours.
5. At zero nothing new starts; running work may finish for at most 1 hour, then it is stopped.
6. Credits: 3.50 kr an hour ex. VAT, packs of 20, 100 and 500 hours, valid 12 months, bought by
   founders only.
7. The Dedicated plan (1,592 kr) is not sold until always-on machines are priced.
8. "Out of hours" email also goes to every founder.

Carried over, not a new founder decision: while any founder of a company has the internal account
entitlement (`qorpera_account_entitlements.plan_key = 'internal'`), the company is complimentary.
Its time is measured and paid by a `complimentary` source naming the first internal founder in the
founder list; it is never charged and never waits. Founder plans are billing records, never new
`plan_key` values: the entitlement table keeps only `freemium` and `internal`, and the client
refuses other keys.

## What counts

| Kind | Counts while | Size | Source |
| --- | --- | --- | --- |
| Company machine (office) | awake | node demand (8 vCPU/16 GiB today → 2.0) | demand `provider_kind = 'office'` |
| Agent machine (#419, not on master yet) | awake | its own requested size | demand `provider_kind = 'machine'` |
| Coding machine, incl. retiring per-session VMs | awake | node demand (4/8 today → 1.0) | demand `provider_kind = 'coding'` |
| Run box | from the runner's acceptance to the end of that attempt | standard (1.0) | `qorpera_runner_assignments` |
| Sign-in and account-refresh machines | never | — | demand `provider_kind = 'login'` is ignored |
| Native run VMs as machines, exec hosts, build VMs, warm spares | never (runs count instead) | — | — |

- Size factor = `max(cpu_millis / 4000, memory_bytes / 8 GiB)`, rounded to 6 decimals, frozen per
  awake stretch. A size change while awake starts a new stretch.
- Awake = the node demand is reserved, not suspended and not released. Admission clears
  `suspended_at` on wake, so the demand row holds no sleep history; the power log does.
- A run counts from `accepted_at` of its runner assignment to the earlier of `finished_at` and
  `expires_at`. The assignment's `expires_at` follows the job lease
  (`20260824002000_runner_assignment_lease_renewal`), so a lost host counts only to its lapsed
  lease; an accepted assignment ends when its job leaves `leased`, stamped with that time. A retry
  is a new assignment; the wait between attempts counts nothing. Every execution run counts,
  proposal reviews included. Run allocations and `native` demands are never read, so a fresh-VM run
  and a run on the shared execution host cost the same, and a late-closed allocation (for example a
  lost reserve reply on the fast host) never extends a run.
- A coding turn's model run is an execution run (a worker-dispatch wake admitted by
  `qorpera_begin_coding_turn`) and counts like any other run; the turn's commands count through
  the coding machine.
- `qorpera_runtime_computer_history` stays an operator estimate from observations. Billing uses
  only the meter.

## Measuring (build step 2)

All inputs are central and on the database clock. No node keeps billing state, keys or journals.
No reserve, release, suspend or observe function is copied or patched.

### Power log and run log

- `qorpera_computer_hour_log` (append-only): `profile_id`, `subject_kind`
  (`company_machine | agent_machine | coding_machine | run`), `subject_id` (allocation or
  assignment), `node_id`, `state` (`awake | asleep | gone`), `size_factor`, `at`.
- Written by two AFTER triggers:
  - on `qorpera_runtime_node_demands` (insert, and updates of `reserved_at`, `suspended_at`,
    `released_at`, `cpu_millis`, `memory_bytes`) when the awake state or an awake machine's size
    changes;
  - on `qorpera_runner_assignments` (insert, and updates of `status`, `accepted_at`,
    `finished_at`) when an assignment is accepted or leaves `accepted`.
- Each row is also queued in `qorpera_computer_hour_inbox`. The meter empties the queue, so a row
  that commits late (a lower id after a higher one) is still read. Per machine or run, transitions
  commit in order, because each comes from an update of that machine's demand row or that run's
  assignment row.
- Log times are the database's: `clock_timestamp()` for machines, the assignment's own times for
  runs. A wake or acceptance that commits late is counted from its own time. Counted time is
  never taken back: an end that arrives for time a pass already counted (at most about a minute)
  ends the stretch there.
- The migration logs everything awake at that moment as awake from then on. Nothing earlier is
  counted.

### Node report check

- Per node, the meter reads `qorpera_runtime_node_observation_receipts` joined with
  `qorpera_runtime_node_inventory_receipts` on `(node_id, observation_id)`, forward from a per-node
  cursor on `(observed_at, observation_id)`. That uses the existing index
  `(node_id, observed_at, observation_id)`; `observed_at` only increases per node, and inserts are
  serialized by the node row lock, so nothing is skipped. It reads only nodes with machines being
  counted, and only reports since the oldest of those machines woke. A new node starts at its
  newest report, never its history.
- Every report that carries an inventory is read, including node-level `unavailable` ones (they
  still list every entry). Times come from `received_at`, the database's clock.
- Per machine counted on that node:
  - entry `running`, `starting` or `stopping`: running; a paused charge resumes;
  - entry `suspended` or `failed`: the charge pauses;
  - entry `unavailable`: unknown, no change;
  - no managed entry: its physical id is looked up in `qorpera_runtime_node_instance_bindings`,
    because a running machine can show up as `unmanaged` when its tags or limits differ; with no
    matching entry, the charge pauses.
- A node that published no inventory for five minutes: the charges of its machines pause five
  minutes after its last report and resume at a report that shows them running.
- A report never starts a charge for a machine the log shows asleep or released. An emptying node
  (`enabled = false`) keeps reporting, and its machines keep running. Build and infrastructure
  entries are ignored.

### Meter

- `qorpera_meter_computer_hours()` runs once a minute. It is scheduled with pg_cron directly
  (`select cron.schedule('qorpera-computer-hour-meter', '* * * * *',
  'select public.qorpera_meter_computer_hours()')`), an operator step at the cut. pg_cron must be
  enabled first: `create extension if not exists pg_cron with schema pg_catalog` (it needs pg_cron
  in `shared_preload_libraries`; production had it preloaded but not created, and the coordinator
  created it at the v147 cut, 2026-09-28). The extension and the job live outside the migrations,
  so a database built by replaying them has neither: enable the extension and schedule the job
  again there. The cron job runs as the function's owner; EXECUTE is otherwise granted only to
  service_role, and the body has no role check of its own. A concurrent call returns `busy`
  (advisory lock), and a call within the same half minute returns `current`.
- Each pass counts up to 30 seconds ago, so late reports and transitions of that time have arrived.
- `qorpera_computer_hour_subjects` holds the machines and runs not yet fully counted; a finished one
  is deleted once counted. The log keeps the history.
- Each pass adds one row per company to `qorpera_computer_hour_usage`: exact standard seconds per
  kind, and `standard_seconds`, what the pass adds after the company's running total
  (`qorpera_computer_hour_totals`) is rounded up to whole seconds.
- It takes no lock on company or member rows (`qorpera_lock_profile_gc_fence` takes the profile
  row FOR UPDATE on every reservation, suspend and lease check). Besides the advisory lock it
  locks only its own working rows and the billing sources a charge may draw from (step 3).
- Reads are indexed and bounded by what changed. It never scans old receipts.
- `qorpera_read_company_computer_hours(profile, month)`: any member of the company; the calendar
  month in Europe/Copenhagen time.
- One usage row per company per pass with use, append-only. A roll-up of old rows (to one per
  company per day, cut in Europe/Copenhagen time) is deferred: usage rows and their draws are kept
  as written until a later step moves old months into daily tables, through a path of its own past
  the append-only guards.

Step 2 shows the measured hours in Plan & usage and charges nothing.

## Billing records (build step 3)

Migration `20260928248300_runtime_computer_hours_ledger`. In the database (5.6: plan, usage and
billing), never in the company folder. No billing table has a cascading link to `qorpera_profiles`
(`qorpera_delete_hosted_profile` hard-deletes it) or to `auth.users`; `profile_id` and `user_id`
are plain columns kept for bookkeeping.

- `qorpera_computer_hour_sources`, one row per source of hours:
  - `free`: one per company, 5 × 3600 standard seconds;
  - `plan_period`: one per founder plan per period (`user_id`, `period_start`, `period_end`).
    A new plan's first period is created when its first invoice is paid. A renewal's period is
    created at the period start; if that period's payment finally fails, its unused part is
    withdrawn and its used part forgiven. An upgrade adds, once its charge is paid, the new plan's
    extra hours in proportion to the time left in the period;
  - `credit`: one per paid purchase (`profile_id`, the buying founder's `user_id`,
    `expires_at` = purchase + 12 months);
  - `complimentary`: one per complimentary company and founder (see Decisions), unlimited;
  - `owed`: time used while the company had no hours, unlimited.
- `qorpera_computer_hour_draws(usage_id, source_id, standard_seconds)` records which source paid
  each usage row, and `qorpera_computer_hour_repayments` which source paid back owed time (with the
  use that triggered it, if any). Both are append-only. The draws of a free, plan or credit source
  never exceed its hours; a usage row's draws equal its `standard_seconds`.
- Each source keeps its drawn (and, for owed, repaid) total, so hours left are a few indexed reads:
  `qorpera_company_computer_hours_left(profile)` = what the company's sources hold minus what it
  owes; null for a complimentary company. `qorpera_read_company_computer_hour_sources(profile)`
  shows operators the sources in the current mode.
- Charging runs in an AFTER INSERT trigger on `qorpera_computer_hour_usage`, inside the meter's
  pass; the meter itself is unchanged.
- Every writer of billing records (the meter, the Stripe webhook of step 4, operators) takes the
  meter's advisory lock first (`qorpera_computer_hour_lock_billing()`), and a charge locks the
  sources it may draw from in id order, so charges, arriving hours, refunds and freezes never
  interleave.

### Charging order (applied by the meter, per usage row)

1. The company's `free` source.
2. The founders' current `plan_period` sources. Founders come from
   `public.qorpera_company_founders(p_profile_id)` (#462), read once per charge; no lock is taken
   on company or member rows, so a founder change that races one pass is harmless. Split evenly in
   whole seconds between the founders with hours left, one share per founder however many current
   periods they have (within a founder, the period that ends soonest pays first). The remainder
   goes a second at a time to the most hours left (then the lowest user id), and when one runs out
   the others carry the rest.
3. The company's `credit` sources, the soonest to expire first.
4. `owed`. Owed time is paid as soon as hours arrive (a trigger on a new plan period, a new credit,
   or a source unfrozen: for a credit its company, for a plan period every company its holder is a
   founder of), and again before each new use, in the same order (free, plans evenly, credits).

A complimentary company draws only from its `complimentary` source (naming the first internal
founder in the founder list), instead of the order above, so its free hours stay unused. It is
checked per pass with "any founder has the internal entitlement" (not through
`qorpera_profile_entitlement_json`, which picks one owner). A member who is not a founder is never a
source. A founder who leaves stops appearing in the founder list, which ends their share at once.
Owed time of a deleted company is written off, once company deletion reaches billing (a later
step; until then a deleted company's records simply stay).

Until live payments are switched on (`qorpera_computer_hour_billing.live_since`), step 3 runs as a
dry run: every source and draw is marked `dry_run`, operators can see who would have paid, and
members see only measured hours (no hours left, no warnings). Usage metered before `live_since`
stays a dry run. At the switch the dry-run records stop counting, and free hours, owed time and
every draw count from then, in live records.

## Payments (build step 4)

Migration `20260928248910_runtime_computer_hours_payments` (4a) and the Edge Function
`supabase/functions/computer-billing` (4b). Stripe API version pinned to `2026-08-26.dahlia` in
every request.

- The database's one billing door is `qorpera_computer_billing(key, method, args)`: service_role
  may call it, but only with a billing key whose SHA-256 is enrolled in
  `qorpera_computer_hour_billing_keys` (nodes hold the service role key and must not be able to add
  paid hours). Methods that write sources take `qorpera_computer_hour_lock_billing()` first (the
  ledger's statement trigger enforces it); the others (checkouts, customers, events, subscription
  state) do not wait for the meter. Paid Stripe facts
  become sources; test-mode payments, and any payment before the live switch, make dry-run
  sources only.
- The catalog (`qorpera_computer_hour_catalog`) holds Basis (185 kr, 74 h a month), Standard (630
  kr, 286 h) and credit packs of 20, 100 and 500 hours at 3.50 kr an hour, all excluding VAT, with
  a Stripe price id per mode that an operator sets. Dedicated is not sold.
- The Edge Function `computer-billing`:
  - `POST /checkout` (member JWT) `{itemKey, profileId?}`: a plan (`mode=subscription`, for the
    member; a member with a plan changes it on the billing page) or credits (`mode=payment`,
    founders only, for their company). It creates the member's Stripe customer once, re-checks
    Stripe's price against the catalog (active, DKK, amount, tax-exclusive, monthly or one-off),
    and starts Checkout with Stripe Tax, address and CVR/VAT number collection, the member's saved
    cards offered, and an idempotency key per checkout. A pack's checkout page closes after an
    hour (Stripe's default is 24), since it is bought for one company.
  - `POST /portal` (member JWT): Stripe's billing page for card changes, invoices, cancelling at
    the period end and switching between Basis and Standard.
  - `POST /webhook`: Stripe's events, signature checked (five-minute window, several
    signatures), recorded once by id (the first body's hash is kept), then re-read from Stripe:
    - `invoice.paid` with `subscription_create`: the first period, from the plan line's service
      period (`lines.data[].period`, `pricing.price_details.price`);
    - `invoice.created` with `subscription_cycle`: a renewal's period at its start, before payment
      (also on `invoice.paid`, idempotent). An `unpaid`, `canceled`, `paused` or
      `incomplete_expired` subscription gets no new period, and paying such a subscription's
      invoice goes to review; so does a renewal paid after it was withdrawn;
    - `invoice.paid` with `subscription_update`: an upgrade's extra hours, pro rata from the paid
      time, as an extra period row. The period is the recorded one that ends where the new plan's
      proration line ends; a payment outside it, a change that lowers the hours at once, and a
      second change in the same period go to review (one top-up per period at most);
    - `customer.subscription.*`: the subscription's state (item-level current period); a
      subscription that ends `unpaid`, `canceled` or deleted with an unpaid renewal, and
      `invoice.marked_uncollectible`, withdraw that renewal's unused hours;
    - `checkout.session.completed` / `async_payment_succeeded` for a paid one-off checkout:
      credits for twelve months;
    - `charge.refunded`: that purchase's unused hours withdrawn; `charge.dispute.created` /
      `updated` / `closed`: the effect follows the dispute's status as Stripe reports it (`won`,
      `warning_closed` or `prevented`: unfrozen; `lost`: withdrawn; otherwise frozen). The
      purchase is the credit pack paid by that PaymentIntent, or the plan hours of the invoice it
      paid (found with `GET /v1/invoice_payments`, through the links from invoices to their
      sources). One that matches nothing goes to review.
  - Everything else, or anything it cannot use, is recorded (`ignored` or `needs_review`) and
    answered 2xx; only a passing failure (Stripe or the database unreachable, a 20-second
    timeout, Stripe refusing our key with 401 or 403, or Stripe's 409 and 429) answers non-2xx,
    and Stripe retries. An event left
    for review runs again when it is resent from Stripe's dashboard, once its cause is fixed.
    Returning from Checkout adds nothing.
  - Before the live switch, test-mode checkout is open only to test accounts an operator enrolled
    in `qorpera_computer_hour_testers`, so members never meet a test page, and live checkout is
    closed (it would take money for dry-run hours). Testers, not internal accounts: a company
    with a founder on an internal account is complimentary and never draws, so test purchases
    must come from a test founder without one to show plans and credits being drawn
    (acceptance, section 21 item 31). The function's key must follow the switch: test key
    before it, live key from it. `qorpera_list_computer_hour_offers()` marks what the member can buy
    now; `qorpera_read_my_computer_plan()` leaves the plan's hours out until then, since members
    see only measured hours (contract item 12).
- Hours arrive as new source rows (a period whose start has come, a credit) or an unfreeze, so
  what the company owes is repaid at once (step 3's trigger). A member made founder repays owed
  time at the company's next use instead. Webhook writes run under READ COMMITTED through the
  billing door, which takes the billing lock before it writes sources.
- Refunds remove the unused hours of their purchase. A dispute freezes only its purchase.
- A pack paid for a company that is gone or being deleted (company delete's
  `qorpera_company_deleting`) adds no credit: a guard on the sources refuses it (migration
  `20260928248970`), so the Stripe event goes to review and an operator refunds the payment. A
  repeated delivery of a payment already credited stays a no-op. Known limit: the guard does not
  lock the company, so a deletion requested in the same instant can let one credit through. That
  payment is not sent to review: an operator finds it as a credit whose company is in
  `qorpera_company_deletions`, and refunds it. Starting a pack checkout for a company being deleted is not refused at
  the start (company delete hides the company from its members at once).
- Known limits, for review rather than code: a failed renewal is found through the subscription's
  latest invoice; a partial refund withdraws the whole purchase, and a failed refund
  (`refund.failed`) does not give it back; two open tabs can start two subscriptions (the member
  pays for both, and one is cancelled on the billing page); the subscription state kept is the
  newest by event time.

### Setting up Stripe (test mode first)

Secrets never pass through a session: Jonas creates and stores every key himself, in the Stripe
dashboard and as Supabase function secrets. The coordinator writes only what is not secret.

Jonas:

1. A Stripe account for Qorpera in test mode (a sandbox). Account default API version:
   `2026-08-26.dahlia`.
2. Stripe Tax on: head office address in Denmark and the Danish VAT registration.
3. Five prices, each tax-exclusive (`tax_behavior=exclusive`, which cannot be changed later): two
   products for the plans, each with one monthly DKK price (Basis 185, Standard 630), and one-off
   DKK prices for 20, 100 and 500 hours (70, 350, 1750). Send the five `price_...` ids (not
   secret) to the coordinator.
4. Customer portal (Settings → Billing → Customer portal): switching between the Basis and
   Standard products with "invoice immediately" for prorations and the billing date unchanged
   (`billing_cycle_anchor=unchanged`), downgrades scheduled at the period end, cancel at the
   period end, payment method update, invoice history. Check in the sandbox that Standard →
   Basis waits for the period end, and that the first Basis invoice after it arrives as a
   renewal (`invoice.created` with `billing_reason=subscription_cycle`). If Stripe cannot
   schedule it (the plans are two products), leave plan switching off in the portal (upgrades
   too) and tell the billing session: members then cancel and choose the other plan, and a
   downgrade that took effect at once would only go to review. To use a portal configuration
   other than the default, set its id (`bpc_...`) as a secret in step 8.
5. Failed payments (Settings → Billing → Subscriptions and emails): after the last retry, cancel
   the subscription. Receipts and invoice emails on.
6. A webhook endpoint (the address is fixed, so before or after the deploy) at
   `https://<project>.supabase.co/functions/v1/computer-billing/webhook`, API version
   `2026-08-26.dahlia`, events `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `invoice.created`, `invoice.paid`,
   `invoice.marked_uncollectible`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`,
   `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`.
7. The billing key. On the Mac, this makes a new random key, puts it on the clipboard and prints
   only its SHA-256 (the key itself is never shown):

   ```bash
   K=$(openssl rand -hex 32); printf %s "$K" | pbcopy; printf %s "$K" | shasum -a 256 | cut -d' ' -f1; unset K
   ```

   Paste the clipboard as the secret `QORPERA_COMPUTER_BILLING_KEY`, then clear the clipboard
   (`pbcopy </dev/null`) and send the printed hash to the coordinator (a hash is not secret), or
   enroll it yourself (coordinator step 2). For a
   key that already exists, `read -rs K; printf %s "$K" | shasum -a 256 | cut -d' ' -f1; unset K`
   prints its hash: paste the key, press Enter, nothing is echoed.
8. The other Supabase function secrets: `QORPERA_STRIPE_SECRET_KEY` (`sk_test_...`),
   `QORPERA_STRIPE_WEBHOOK_SECRET` (`whsec_...`, from step 6), `QORPERA_BILLING_RETURN_URL`
   (`https://app.qorpera.com/#/account`), `QORPERA_WEB_ORIGINS` (`["https://app.qorpera.com"]`)
   and optionally `QORPERA_STRIPE_PORTAL_CONFIGURATION`.
9. Name the accounts that may buy in test mode (for example a second account of Jonas's). To see
   plans and credits being drawn, a tester founds a test company with no founder on an internal
   account (a company with an internal founder is complimentary and never draws).

Coordinator (nothing secret):

1. Deploy the function: `supabase functions deploy computer-billing`.
2. Enroll the billing key's hash from Jonas:
   `insert into public.qorpera_computer_hour_billing_keys (key_sha256) values ('<hash>')`.
3. Write the five test price ids into `qorpera_computer_hour_catalog.stripe_price_test`, by
   `item_key`: `basis`, `standard`, `hours_20`, `hours_100`, `hours_500`.
4. Enroll the test accounts: `insert into public.qorpera_computer_hour_testers (user_id, note)
   values ('<user id>', '<who>')`.

Live keys come later, with the live switch (build step 7).

## Email (build step 5)

- Stripe sends receipts and invoices to the paying member (customer email = account email).
- Qorpera's hour notices use an outbox drained by an Edge Function that sends through Resend, like
  invitations (`supabase/INVITATION-EMAIL.md`). They go only to founders:
  - "hours running low" (a fifth or less of the hours in what pays now is left: the free hours,
    the founders' current plan periods and the company's credits, each while it has hours left;
    or less than one hour) and "out of hours" go to the founders whose plans pay, the
    founders who bought the credits in use, or every founder on free hours;
  - "out of hours" also goes to every founder;
  - one monthly summary to each founder whose plan was used, at the end of that plan's period,
    listing each company's use.
- Built switched off; switched on together with live payments.
- Admins, contributors and viewers get no billing email. In-app notices that mirror the emails
  come with a later web step.

Migration `20260929160000_runtime_computer_hour_notices` and the Edge Function
`supabase/functions/computer-hour-notices` (logic in `supabase/functions/_shared/computer-hour-notices.ts`):

- `qorpera_computer_hour_notices` is the outbox: one row per recipient and occasion (kind, founder,
  occasion unique), with what the email says fixed when queued (a company deleted later keeps its
  name there).
- An AFTER INSERT trigger on `qorpera_computer_hour_usage`, running after the charge trigger,
  queues "running low" and "out of hours". It acts only on live charges, so before the live switch
  nothing is queued: that is the "switched off". Complimentary companies get none.
  - Running low: once a calendar month (Danish time) per company and recipient; a company still
    low when a month begins is told again that month. The payers are founders whose current plan
    period has hours left and founders whose credits have hours left. A founder's plan used up by
    another company does not count toward this company's "what pays now".
  - Out of hours: once per time the company runs out. A time starts when it begins to owe; any
    hours arriving (even too few to clear the debt) end it, and running out again is a new time.
  - Both wait ten minutes before they are sent. The worker drops one (cancelled) if the company
    is no longer low, no longer owes, or owes in a newer time; for instance, a plan renewal
    recorded moments after the meter charged. It also drops "running low" once the company has run
    out ("out of hours" says it), or once the company is complimentary. A dropped "running low"
    frees its month, so running low again is told. A recipient who is no longer a founder is
    marked failed.
  - Known limit: a renewal recorded more than ten minutes late (a delayed Stripe webhook) still
    sends "out of hours" for the gap.
  - Reaching zero without owing (hours taken back, credits expiring, a plan ending) queues nothing,
    since no use follows once the zero rule holds work back. Build step 6 sends "out of hours"
    when it first holds a company's work back.
- Summaries are queued by the worker's claim for plan periods that ended ten minutes ago or more
  (so the last meter pass has committed) and within seven days, one per founder and period (its
  `sub_…:start` reference). Each lists the company's draws and repayments across the period and its
  upgrade top-up. A period nobody used is marked done (cancelled) without an email.
- `qorpera_claim_computer_hour_notices(limit, lease)` (service_role) drops what no longer holds.
  That covers the cases above, plus a recipient with no email address and a notice leased eight
  times. It then leases due rows for five minutes with `skip locked` and returns each with the
  founder's current address. `qorpera_complete_computer_hour_notice` and
  `qorpera_fail_computer_hour_notice` record the outcome: retryable failures wait 1, 2, 4 ...
  minutes (at most an hour) and stop after eight attempts.
- The worker sends ten per call with a ten-second timeout per send, well inside the lease. A
  notice it cannot read is failed for good, so it holds up no other. Resend gets
  `qorpera-computer-hour-notice/<id>` as its idempotency key.
- The emails are in English, like invitations, show days in Danish time, and link to the web app's
  account page (Plan & usage).

### Turning the notices on

Schedule the worker before the live switch (it sends nothing until then, and summaries are only
looked for within seven days of a period's end).

Jonas (secrets):

1. The Resend sender: the existing `RESEND_API_KEY` serves; set the function secrets
   `QORPERA_HOURS_FROM` (for example `Qorpera <hours@mail.qorpera.com>`, on the verified domain) and
   `QORPERA_APP_URL` (`https://app.qorpera.com/`).
2. In the database's Vault, the project URL and a Supabase secret key for the worker, as the
   invitation email needs (`supabase/INVITATION-EMAIL.md`, "Schedule"). The project URL may already
   be there for invitations; skip it if so:
   `select vault.create_secret('https://<project>.supabase.co', 'qorpera_project_url');` and
   `select vault.create_secret('<sb_secret_…>', 'qorpera_computer_hour_notice_key');`.
   The key is created in the Supabase dashboard and never passes through a session.

Coordinator (nothing secret):

1. Deploy the function: `supabase functions deploy computer-hour-notices`.
2. Schedule the worker every minute (pg_cron and pg_net):

   ```sql
   select cron.schedule('qorpera-computer-hour-notices', '* * * * *', $$
   	select net.http_post(
   		url := (select decrypted_secret from vault.decrypted_secrets where name = 'qorpera_project_url')
   			|| '/functions/v1/computer-hour-notices',
   		headers := jsonb_build_object('content-type', 'application/json',
   			'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'qorpera_computer_hour_notice_key')),
   		body := '{}'::jsonb)
   $$);
   ```

3. Watch it by count, not by address:
   `select kind, status, count(*) from public.qorpera_computer_hour_notices group by 1, 2 order by 1, 2`.
4. Rollback: `select cron.unschedule('qorpera-computer-hour-notices')` stops sending. The trigger
   keeps queueing, harmlessly; `drop trigger qorpera_computer_hour_notice_usage on
   public.qorpera_computer_hour_usage` stops that too.

## Zero (build step 6; built switched off)

- The check is `qorpera_company_computer_hours_left(p_profile_id)` (step 3): more than zero, or
  null for a complimentary company.
- A complimentary company always passes.
- It is checked before a run is created (not at claim or placement: a run waiting there is
  invisible to members) and at each machine kind's own start or wake step. A run created before
  the company ran out is running work. The hook list is agreed with the nodes (S3), machines,
  company-machine and coding sessions before building.
- Work that cannot start waits before a run exists, with a stated reason ("waiting for computer
  hours"), and starts by itself in the order it arrived once the company has hours left. It never
  fails by age.
- Running work may finish for at most 1 hour at zero. Then its runs end as `failed` with the
  reason "out of computer hours" through the system path that ends a runner attempt, with no
  automatic retry. The job's `last_error` carries a stable code for it, and the web's failed-run
  card (`packages/web/src/ui/run-failure.ts`) learns to show it as "Out of computer hours" rather
  than an internal error or a usage limit; it matches the code before the card strips
  `[code=...]` tags. It is not a member's Stop: no routine is paused and no
  worker cancelled. Its machines, always-on ones included, are stopped with their disks kept. A
  coding turn cut off then ends failed with the same reason, and its machine's running commands end
  as when it sleeps. An in-house worker whose run is ended reports "out of computer hours" to its
  parent instead of the generic "ended without reporting a result".
- A new coding turn waits like other new work, whether a run starts it or the session's owner
  answers the session directly (`qorpera_answer_coding_session`, which opens the turn without a
  run). The hook list covers `qorpera_coding_session_queue` and the turn's own run at
  `qorpera_begin_coding_turn`. Two executor pieces are needed: a new waitable reason for the
  coding machine's step (`qorpera_authorize_coding_machine_run`, which every turn passes before
  begin), and a catch around begin that ends the turn and defers the session
  (`qorpera_defer_coding_session`) instead of failing it; an attached session stays on its
  machine for the keeper. The queue has no leased session to defer, so it accepts the turn, and
  the turn waits in the executor, at its machine's step or at begin. The defer step's fixed text
  ("Waiting for a coding machine") and `last_step` gain the "waiting for computer hours" reason,
  so it shows in the session's thread. At the hour, a cut-off turn's run is ended before its
  machine is stopped.
- When it first holds a company's work back, it queues "out of hours" for every founder in step
  5's outbox, if none is open for that time. This covers a company reaching zero without owing:
  hours taken back, credits expiring, or a plan ending. No use follows then, so step 5's trigger
  never sees it. It needs its own occasion, and step 5's claim rule, which drops an "out of hours"
  unless the company still owes in the same time, must learn to keep it.
- A plan renewal is recorded when Stripe's renewal invoice arrives, which can trail the period's
  end by minutes. The check must not hold work back in that gap: for instance, it can treat a
  founder's active subscription whose recorded period just ended as still paying for a short
  grace window.
- It ships switched off, in its own release, with a 30-minute database watch after the cut. It is
  switched on together with live payments and hour notices.

## Plan & usage (web)

- The company card, seen by every member: hours used this month, by kind; from the live switch
  also by source, and hours left. From the live switch, founders also see each founder's share
  and a "Buy hours" button (before it, only founders who are enrolled testers see it, in Stripe's
  test mode).
- Your plan, seen only by you: plan, hours used per company, reset date, "Change plan" and
  "Payments and invoices" (Stripe's billing page).
- Admins, contributors and viewers see the company's hours without names or cards: "Computer
  hours are paid by the founders. You are never charged."
- The false Basis line "A worker computer for every agent, 74 hours" is removed.

## Build order

Each step is a small feature PR on the release train: no bundle, manifest or activation files,
migration slots registered in the bundle registry after the newest live activation, an independent
exact-head review, and a hand-off to the coordinator (message, PR comment, registry line).

1. Contract text and this design (docs only).
2. Measuring: logs, meter, report check, read RPC; Plan & usage shows real hours. Its own release
   with a database watch, and the cron job.
3. Billing records and the charging order, as a dry run.
4. Payments in Stripe test mode: checkout, billing page, webhook, catalog.
5. Email, switched off. In-app notices that mirror the emails follow in a web PR.
6. Zero: the check, the waiting state, the finishing window, switched off. Its own release.
7. Live: Jonas sets the live Stripe keys; the coordinator switches payments, hour notices and the
   zero rule on together.

## Not repeated from #326

- No payment gate on founding.
- No host keys, executor keys, guard journals or per-host samples.
- The shared execution host is not refused; a run costs the same anywhere.
- No copied admission functions, and no patched hash-guarded inventory functions.
- Migrations after the newest live activation.
- Contract text first.
- Every machine kind counted, with computer and machine kept apart.
- No monthly zero between plan periods, no hard stop without warning, no 5xx loop with Stripe.
- No per-founder "contribute my plan" opt-in; the founders' plans pool by rule.
- No meter lock on company rows.
