# Computer hours (billing of machine time)

Founder approval: 28 September 2026, page "Computer Hours"
(https://claude.ai/artifact/Y2kYvCnpqXDaqHnNkCjhBi), all eight choices as recommended, on top of
the decisions recorded when draft PR #326 was closed. Contract: section 19, 2026-09-28 amendment
"computer hours". This file is the technical design; the page is the plain one.

Status: design. Nothing below is built yet. Table and function names are working names; each
build step fixes its own names in its migration and in `supabase/CLIENT-CONTRACT.md`.

## Decisions

Fixed on 28 September (the #326 audit):
- The name is "computer hours". What is billed is machine time. A company machine hosts up to six
  computers. Every machine kind counts: company machines, agents' machines, coding machines and
  run boxes.
- Hours are pooled across the co-founders' plans. The company can also buy credits with any card
  a founder picks. Contributors who are not founders are never billed personally.
- Every company gets 5 free computer hours. No payment before Start.
- Billing email goes to the card owner who bought the credits, or to the founders whose plan was
  used.
- Only the last member may delete a company (built by the membership work, S2).

Chosen on the page (recommended option each time):
1. A machine counts by size: 1 hour per hour for a standard machine (4 vCPU, 8 GiB), by the larger
   of its CPU and memory ratio.
2. The 5 free hours are used first by every company, whether or not a founder pays.
3. Founders' plans pay before company credits.
4. Plans are shared evenly between the founders who still have hours.
5. At zero nothing new starts; running work may finish for at most 1 hour, then its machine stops.
6. Credits: 3.50 kr an hour ex. VAT, packs of 20, 100 and 500 hours, valid 12 months, bought by
   founders only.
7. The Dedicated plan (1,592 kr) is not sold until always-on machines are priced.
8. "Out of hours" email also goes to every founder.

## What counts

| Machine | Counts while | Size used | Record |
| --- | --- | --- | --- |
| Company machine (office) | awake: from admitted wake until confirmed power-off | node demand `cpu_millis`/`memory_bytes` (8 vCPU/16 GiB today → 2.0) | allocation (`office_id`) + power log |
| Agent machine (#419) | awake | its own requested size | allocation (`company_machine_placement_id`) + power log |
| Coding machine | awake | node demand (4/8 today → 1.0) | allocation (`coding_machine_id`) + power log |
| Run box | from run start to run end | standard (1.0), wherever it runs | the run's own start/end |
| Sign-in machines, exec hosts, build VMs, warm spares | never | — | — |

- Size factor = `max(cpu_millis / 4000, memory_bytes / 8 GiB)`, frozen per awake stretch from the
  node demand at wake. A size change starts a new stretch.
- Runs are metered from the run record only, never from run allocations or node demands, so a run
  on the shared execution host and a run in a fresh VM cost the same, and nothing is counted twice.
  A late-closed allocation (for example a lost reserve reply on the fast host) never extends a run.
- Sign-in machines serve one member's model login, not company work. Parked warm hosts are the
  platform's choice to keep capacity ready.

## Measuring (build step 2)

All inputs are central and on the database clock. No node keeps billing state, keys or journals.

### Power log

Today `qorpera_runtime_node_demands.suspended_at` is overwritten on every wake, so past sleep and
wake times are lost. A new append-only table records every transition:

- `qorpera_computer_power_log(id, allocation_id, profile_id, machine_kind, state awake|asleep|gone,
  cpu_millis, memory_bytes, at clock_timestamp())`.
- Written by an AFTER trigger on `qorpera_runtime_node_demands` (a demand is reserved, its
  `suspended_at` is set or cleared, or its `released_at` is set). No reserve, release or observe
  function body is copied or patched.
- `profile_id` and the kind are copied from `qorpera_runtime_machine_allocations` at write time.
  Run allocations (`run_id`) are ignored by the trigger.

### Observer check

`qorpera_runtime_node_observation_receipts` joined with `qorpera_runtime_node_inventory_receipts`
on `(node_id, observation_id)`, read forward with a cursor on `(received_at, observation_id)`.
Every receipt that carries an inventory is read, including node-level `unavailable` ones (they still
list every entry).

Per awake allocation:
- entry state `running`, `starting` or `stopping`: seen awake;
- entry state `suspended` or `failed`: the charge ends at that observation's `observed_at`;
- entry state `unavailable`: unknown, no effect;
- absent from the managed entries: look up its physical id in
  `qorpera_runtime_node_instance_bindings`. An `unmanaged` entry with that physical id in state
  `running` is still awake; otherwise the charge ends at that observation;
- the node has published no inventory for 5 minutes: the charge pauses at the last inventory plus
  5 minutes, and resumes only at an inventory that shows the machine running.

A node that is emptying (`enabled = false`) keeps reporting, and its machines keep running; that is
never read as stopped. Build and infrastructure entries are ignored.

### Meter

- One SQL function, run once a minute by Supabase Cron (the same operator pattern as the invitation
  email). It is idempotent and takes one advisory lock, so a duplicate call is a no-op.
- For each awake stretch and each finished or running run, it appends the new seconds since its last
  cursor to `qorpera_computer_hour_usage(id, profile_id, allocation_id | run_id, machine_kind,
  size_factor, from_at, to_at, standard_seconds)`.
- `standard_seconds` is the difference of the rounded-up running totals (the #326 technique), so
  more frequent metering never adds to a bill.
- It reads only new rows (the power log, finished runs and the receipt cursor). It never scans old
  receipts; see the production note on heavy scans.
- Company totals follow the calendar month in Europe/Copenhagen time.

Step 2 shows the measured hours in Plan & usage and charges nothing.

## Billing records (build step 3)

In the database (5.6: plan, usage and billing), never in the company folder. None of these tables
has a foreign key to `qorpera_profiles`: `qorpera_delete_hosted_profile` hard-deletes that row with
cascades, and billing rows must outlive it for bookkeeping (5 years).

- `qorpera_computer_hour_sources`: one row per source of hours.
  - `free`: one per company, 5 × 3600 standard seconds, created at the company's first metered
    second.
  - `plan_period`: one per founder plan per period; `user_id`, `period_start`/`period_end`, hours.
    It is created at the period start and withdrawn (unused part) only if the period's invoice
    finally fails.
  - `credit`: one per paid purchase; `profile_id`, the buying founder's `user_id`, `expires_at` =
    purchase + 12 months.
  - `owed`: time used past zero.
- `qorpera_computer_hour_draws(usage_id, source_id, standard_seconds)` records which source paid
  each usage slice. Checks keep a source's draws at or below its hours, and a slice's draws equal
  to its seconds.
- A cached balance per source, updated with the draws, keeps the zero check a single indexed read
  without locks on company or plan rows.

### Charging order (applied by the meter, per usage slice)

1. The company's `free` source.
2. The founders' current `plan_period` sources: founders =
   `public.qorpera_company_founders(p_profile_id)` (S2; the owners, read with the profile row
   locked `for share`). Split evenly between those with hours left, and the rest carried by the
   others when one runs out.
3. The company's `credit` sources, oldest expiry first.
4. `owed`. It is paid first from the next source that gains hours.

A contributor's plan or card is never a source for a company. A founder who leaves stops appearing
in `qorpera_company_founders`, which ends their share at once.

## Payments (build step 4)

- A new Edge Function `computer-billing`:
  - `POST /checkout` (member JWT) for a plan (`mode=subscription`) or credits (`mode=payment`,
    founders only);
  - `POST /portal` (member JWT) for the payment provider's billing page, with plan switching on:
    an upgrade applies at once with proration, a downgrade at the period end;
  - `POST /webhook` for Stripe's messages.
- Webhook, patterns kept from #326:
  - verify the raw body's HMAC signature (tolerance 5 minutes, several signatures);
  - store each event once by id and body hash;
  - take a short lease, then re-read the subscription, invoice or payment from Stripe;
  - apply the result in one transaction.
  - Only `invoice.paid` or a succeeded payment adds hours; returning from checkout adds nothing.
  - Unknown or unsupported events are stored as `needs_review` and still answered 2xx (#326
    answered 5xx, so Stripe would retry for days and then disable the endpoint).
- Refunds remove the unused hours of their purchase. A dispute freezes only its purchase.
- The plan catalog lives in the database with each Stripe price id. Checkout re-verifies the price.
  Prices exclude VAT. Stripe Tax adds Danish VAT, or applies reverse charge for EU buyers with a VAT
  id, and checkout collects the address and an optional CVR/VAT number.
- Secrets: the Stripe secret key and the webhook signing secret are Supabase secrets, set by Jonas.
  The functions that add paid hours are callable only with a billing key held by this Edge
  Function (nodes hold the service role key, which must not be able to add paid hours).
- Test mode first. Live keys are set by Jonas, and the coordinator switches payments on.

## Email (build step 5)

- Stripe sends receipts and invoices to the paying member (customer email = account email).
- Qorpera's hour notices use an outbox and the existing Resend setup, like invitations
  (`supabase/INVITATION-EMAIL.md`):
  - hours running low (20 % left) and out of hours go to the members whose hours are being used:
    founders whose plans pay, buyers of the credits in use, or every founder on free hours;
  - "out of hours" also goes to every founder;
  - one monthly summary per founder plan period, listing each company's use.
- Contributors get no billing email. In-app notices mirror the emails.

## Zero (build step 6, its own release)

- One function, `qorpera_company_has_computer_hours(p_profile_id)`, reads the cached balances.
- It is checked at run creation (not at claim or placement: a run waiting there is invisible to
  members) and at each machine kind's own start or wake step. The hook list is agreed with the
  nodes (S3), machines, company-machine and coding sessions before building.
- Work that cannot start waits with a stated reason ("waiting for computer hours") and starts by
  itself, in order, when hours arrive.
- Running work may finish for at most 1 hour past zero. Then its machine is stopped (disk kept).
- It ships alone, with a 30-minute database watch after the cut.

## Plan & usage (web)

- The company card, seen by every member: hours used this month, by source and by machine kind,
  and hours left. Founders also see each founder's share and a "Buy hours" button.
- Your plan, seen only by you: plan, hours used per company, reset date, "Change plan" and
  "Payments and invoices" (Stripe's billing page).
- Contributors see the company's hours without names or cards: "Computer hours are paid by the
  founders. You are never charged."
- The false Basis line "A worker computer for every agent, 74 hours" is removed.

## Build order

Each step is a small feature PR on the release train: no bundle, manifest or activation files,
migration slots registered in the bundle registry after the newest live activation, an independent
exact-head review, and a hand-off to the coordinator (message, PR comment, registry line).

1. Contract text and this design (docs only).
2. Measuring: power log, meter, observer check, read RPC, Plan & usage shows real hours. Its own
   release with a database watch.
3. Billing records and the charging order: sources, draws, free hours, the founder list. Nothing
   is charged or stopped.
4. Payments in Stripe test mode: checkout, billing page, webhook, catalog.
5. Email.
6. Zero: the check, the waiting state, the finishing window. Its own release.
7. Live: Jonas sets the live Stripe keys; the coordinator switches payments on.

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
