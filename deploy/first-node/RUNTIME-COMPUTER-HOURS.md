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
  'select public.qorpera_meter_computer_hours()')`), an operator step at the cut. The cron job runs
  as the function's owner; EXECUTE is otherwise granted only to service_role, and the body has no
  role check of its own. A concurrent call returns `busy` (advisory lock), and a call within the
  same half minute returns `current`.
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

Migration `20260929090000_runtime_computer_hours_ledger`. In the database (5.6: plan, usage and
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

Migration `20260929110000_runtime_computer_hours_payments` (4a) and the Edge Function
`supabase/functions/computer-billing` (4b). Stripe API version pinned to `2026-08-26.dahlia` in
every request.

- The database's one billing door is `qorpera_computer_billing(key, method, args)`: service_role
  may call it, but only with a billing key whose SHA-256 is enrolled in
  `qorpera_computer_hour_billing_keys` (nodes hold the service role key and must not be able to add
  paid hours). Writing methods take `qorpera_computer_hour_lock_billing()` first. Paid Stripe facts
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
    cards offered, and an idempotency key per checkout.
  - `POST /portal` (member JWT): Stripe's billing page for card changes, invoices, cancelling at
    the period end and switching between Basis and Standard.
  - `POST /webhook`: Stripe's events, signature checked (five-minute window, several
    signatures), recorded once by id and body hash, then re-read from Stripe:
    - `invoice.paid` with `subscription_create`: the first period, from the plan line's service
      period (`lines.data[].period`, `pricing.price_details.price`);
    - `invoice.created` with `subscription_cycle`: a renewal's period at its start, before payment
      (also on `invoice.paid`, idempotent);
    - `invoice.paid` with `subscription_update`: an upgrade's extra hours, pro rata from the paid
      time, as an extra period row;
    - `customer.subscription.*`: the subscription's state (item-level current period); a
      subscription that ends `unpaid`, `canceled` or deleted with an unpaid renewal, and
      `invoice.marked_uncollectible`, withdraw that renewal's unused hours;
    - `checkout.session.completed` / `async_payment_succeeded` for a paid one-off checkout:
      credits for twelve months;
    - `charge.refunded`: that purchase withdrawn; `charge.dispute.created` / `closed`: frozen,
      then unfrozen (won) or withdrawn (lost).
  - Everything else, or anything it cannot use, is recorded (`ignored` or `needs_review`) and
    answered 2xx; only a passing failure (Stripe or the database unreachable, or the billing key
    refused) answers 5xx, and Stripe retries. Returning from Checkout adds nothing.
- Hours arrive as new source rows (a period whose start has come, a credit) or an unfreeze, so
  what the company owes is repaid at once (step 3's trigger). A member made founder repays owed
  time at the company's next use instead. Webhook writes run under READ COMMITTED through the
  billing door, which takes the billing lock first.
- Refunds remove the unused hours of their purchase. A dispute freezes only its purchase.

### Setting up Stripe (Jonas; test mode first)

1. A Stripe account for Qorpera in test mode (a sandbox). Account default API version:
   `2026-08-26.dahlia`.
2. Stripe Tax on: head office address in Denmark and the Danish VAT registration.
3. Five prices, each tax-exclusive (`tax_behavior=exclusive`, which cannot be changed later): two
   products for the plans, each with one monthly DKK price (Basis 185, Standard 630), and one-off
   DKK prices for 20, 100 and 500 hours (70, 350, 1750). Send the five `price_...` ids (not
   secret); an operator writes them into the catalog.
4. Customer portal (Settings → Billing → Customer portal): switching between the Basis and
   Standard products, "invoice immediately" for prorations, downgrades at the period end (check
   in the sandbox that Standard → Basis waits for the period end; if not, downgrades apply at
   once without proration), cancel at the period end, payment method update, invoice history.
   Optionally send the configuration id (`bpc_...`).
5. Failed payments (Settings → Billing → Subscriptions and emails): after the last retry, cancel
   the subscription. Receipts and invoice emails on.
6. After the coordinator deploys `computer-billing`: a webhook endpoint at
   `https://<project>.supabase.co/functions/v1/computer-billing/webhook`, API version
   `2026-08-26.dahlia`, events `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `invoice.created`, `invoice.paid`,
   `invoice.marked_uncollectible`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`,
   `charge.dispute.created`, `charge.dispute.closed`.
7. Supabase secrets (Jonas sets them; no session reads them): `QORPERA_STRIPE_SECRET_KEY`
   (`sk_test_...`), `QORPERA_STRIPE_WEBHOOK_SECRET` (`whsec_...`), `QORPERA_COMPUTER_BILLING_KEY`
   (a random secret of at least 32 characters), `QORPERA_BILLING_RETURN_URL`
   (`https://app.qorpera.com/`), `QORPERA_WEB_ORIGINS` (`["https://app.qorpera.com"]`) and
   optionally `QORPERA_STRIPE_PORTAL_CONFIGURATION`. The coordinator enrolls the SHA-256 of the
   billing key.

Live keys come later, with the live switch (step 7).

## Email (build step 5)

- Stripe sends receipts and invoices to the paying member (customer email = account email).
- Qorpera's hour notices use an outbox drained by an Edge Function that sends through Resend, like
  invitations (`supabase/INVITATION-EMAIL.md`). They go only to founders:
  - "hours running low" (a fifth or less of the hours the company had at the start of the month,
    or less than one hour, is left) and "out of hours" go to the founders whose plans pay, the
    founders who bought the credits in use, or every founder on free hours;
  - "out of hours" also goes to every founder;
  - one monthly summary to each founder whose plan was used, at the end of that plan's period,
    listing each company's use.
- Built switched off; switched on together with live payments.
- Admins, contributors and viewers get no billing email. In-app notices mirror the emails.

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
- It ships switched off, in its own release, with a 30-minute database watch after the cut. It is
  switched on together with live payments and hour notices.

## Plan & usage (web)

- The company card, seen by every member: hours used this month, by kind; from the live switch
  also by source, and hours left. From the live switch, founders also see each founder's share
  and a "Buy hours" button.
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
5. Email, switched off.
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
