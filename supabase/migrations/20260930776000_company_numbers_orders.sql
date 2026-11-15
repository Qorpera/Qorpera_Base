-- 20260930776000: the platform's own numbers of a company, door `orders` (company views step 5, slice O1; the lane's
-- DESIGN-5-orders.md, shape C, §C "Table and trigger" and "The questions"). A company's shop today is a site whose Buy
-- buttons are Stripe Payment Links (the founder, 15 November 2026: "Stripe payment links are the shop for now"); each
-- purchase reaches the company's Stripe hook as a signed event. When the vault verifies such a delivery, a trigger
-- turns it into one counts-only order row in this database. The company numbers' dispatcher (20260930767000, its site
-- questions 20260930768000) answers five questions on them: `qorpera/orders-now`, `orders-hours`, `orders-days`,
-- `orders-months`, `orders-states`.
--
-- 1. Tables, closed to every API role (RLS on, no grants), each going with its company (on delete cascade):
--    * qorpera_orders: one row a payment, keyed by the company, Stripe's `livemode` and the sha256 of
--      `<company id>:<payment_intent id>` (the Checkout Session's id when it has none). It keeps when the order was made
--      (the session's `created`), its currency and amount in Stripe's minor units, what was refunded so far, the dispute
--      (`open`, `won`, `lost`), the state (`paid`, `failed`, and the company's own `packed`, `on_the_way`, `delivered`,
--      `cancelled`, which slice O2 writes) with when it was set and by what kind (`stripe`, `agent`, `member`), the hook
--      (set null when it goes: removing a hook keeps its orders), and what the upkeep last added to the days. Kept 400
--      days after the order was made.
--    * qorpera_order_days: orders, sales and refunds a company, environment, mode (live or test), day and currency, the
--      company's calendar day, added by the upkeep: kept as long as the company. Refunds count on the order's day.
--    * qorpera_order_retries: a verified delivery whose order row was locked when it came (only its id), retried by the
--      upkeep while its body is kept (7 days).
--    * qorpera_order_upkeep: one row, the upkeep's last run.
--    Never kept: a buyer's name, email, phone, address, country, IP, card brand or digits, Stripe's customer id,
--    metadata, description, line items; nor Stripe's own payment, session or event id (only the hash above).
-- 2. The trigger, after a delivery's status turns `verified` (qorpera_finish_event_verification, 20260928409980, is not
--    patched; nor is the hold, 20260928549330): for a hook whose proof is `stripe`, it reads the body as JSON and takes
--    only these fields of these event types (DESIGN-5 §A.3), Stripe's event `created` for when a fact happened:
--      checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed:
--        `id`, `mode` (payment only: a subscription's later refunds and disputes name its invoices' payments, which its
--        session never names, so they could not be joined; setup is no order), `amount_total`, `currency`, `payment_intent`,
--        `created`, `livemode`, and for completed `payment_status` (paid and no_payment_required are paid; unpaid
--        waits for the async event). Succeeded is paid, failed is failed.
--      charge.refunded: `payment_intent`, `amount_refunded` (Stripe's running total), `livemode`.
--      charge.dispute.created (open), charge.dispute.closed (`status`: won, or warning_closed, which kept the money,
--        is won; lost is lost): `payment_intent`, `status`, `livemode`.
--    Any other type, a field missing or of another shape, a body that is not JSON: nothing (never an error). Each fact
--    is merged so the order of events does not matter: a refund or a dispute before its session makes the row, and the
--    session fills when and how much; refunded is the largest total seen; paid is never undone by failed, nor by an
--    unpaid session; the company's states are never touched; a dispute moves only to a newer event's (a close beats an
--    open of the same second). The upsert waits at most 100 ms for a lock; on contention (or a deadlock) the delivery's
--    id is put in qorpera_order_retries for the upkeep. Whatever happens, the verification stands: every error is caught.
-- 3. The back-fill, qorpera_order_backfill(): every verified delivery of a Stripe hook whose body is still kept (the
--    last 7 days), run once by this migration.
-- 4. The upkeep, qorpera_order_upkeep(), by pg_cron every 10 minutes as its owner (job qorpera-orders; where pg_cron is
--    absent or the role may not use it, nothing is scheduled and the migration still applies; undo: select
--    cron.unschedule('qorpera-orders')): retries what was missed, adds each changed order's difference to its day (in
--    the company's zone at that run), and deletes order rows 400 days after the order (orphans, a refund whose session
--    never came, 400 days after they were made). Until an order is added, the day questions read its difference from
--    the order row, so a day is whole at any time.
-- 5. The orders questions, in the data gateway's answer shape. Who may read them is decided in one place,
--    qorpera_company_numbers_orders_readable: everyone in the company, as site visits (the founder, 15 November 2026,
--    DESIGN-5 §E; the two doors already admit only a member of the company or a run of it). Every question takes
--    `currency` (three letters; by default the currency of most of the mode's orders in the last 90 days, else DKK) and
--    `test` (true answers test-mode orders, kept apart). Money is a JSON number in the currency's major unit (two
--    decimals; zero-decimal currencies such as JPY whole; three-decimal ones such as KWD three). An order is a paid one:
--    pending and failed payments are not orders. Only counts and sums are answered, never one order.
--      orders-now     one row always: stripe (none: no Stripe hook; waiting: none verified a delivery yet; live),
--                     orders_today, sales_today, to_pack (paid, not refunded in full (a free one counts), no state of
--                     the company's yet, and made no earlier than the first order of the same mode the company ever
--                     gave a state of its own, so a shop that starts marking late never sees its whole history; null
--                     when the company set none in 90 days), on_the_way, refunds_30d (refunded on the orders of
--                     the 30 days to today), disputes_open, last_order_at (ISO, UTC). to_pack, on_the_way,
--                     disputes_open and last_order_at count every currency; the rest the one asked.
--      orders-hours   hour (ISO, UTC), hour_local, orders, sales: every hour from `from` to `to`, zeros included; by
--                     default the 48 hours to this one; at most 7 days. `from`, `to` as the site questions take them.
--      orders-days    day, orders, sales, refunds: every day from `from` to `to`; by default the 30 days to today; at
--                     most 400 days.
--      orders-months  month (YYYY-MM), orders, sales, refunds: this month and the 11 before.
--      orders-states  state, orders, amount: paid, packed, on_the_way, delivered, cancelled, failed, in that order,
--                     for the orders made from `from` to `to` (days, as orders-days, but at most 400 days back: the
--                     order rows go then).
--
-- Every inserted text names this migration (20260930776000).

do $$
begin
	if to_regclass('public.qorpera_orders') is not null then
		raise exception '20260930776000 (orders) is already applied'; end if;
	if to_regprocedure('public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)') is null
		or to_regprocedure('public.qorpera_company_numbers_zone(uuid)') is null
		or to_regclass('public.qorpera_event_deliveries') is null
		or to_regclass('public.qorpera_event_hook_capture_keys') is null then
		raise exception '20260930776000 (orders) needs the company numbers (20260930767000, 20260930768000) and Stripe hooks';
	end if;
	if strpos((select prosrc from pg_proc
			where oid = 'public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)'::regprocedure),
			'20260930768000') = 0 then
		raise exception '20260930776000 (orders) needs the site questions (20260930768000) in the dispatcher'; end if;
end $$;

set local lock_timeout = '3s';

-- 1. Tables ------------------------------------------------------------------------------------------------------------

create table public.qorpera_orders (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	-- The Stripe hook that brought it; removing a hook keeps its orders.
	hook_id uuid references public.qorpera_event_hooks(id) on delete set null,
	-- `added`: an order outside Stripe, written by slice O2's order-add.
	source text not null check (source in ('stripe', 'added')),
	-- Stripe's livemode: test orders are kept apart and answered only when asked.
	live boolean not null,
	-- sha256 (hex) of '<company id>:<payment_intent id>', or of the Checkout Session's id when it has none.
	ref_sha256 text not null check (ref_sha256 ~ '^[0-9a-f]{64}$'),
	-- The session's `created`; null until the session's event came (a refund or a dispute came first).
	ordered_at timestamptz,
	currency text check (currency ~ '^[a-z]{3}$'),
	-- What the buyer paid, VAT and shipping included, in Stripe's minor units.
	amount_minor bigint check (amount_minor >= 0),
	refunded_minor bigint not null default 0 check (refunded_minor >= 0),
	dispute text check (dispute in ('open', 'won', 'lost')),
	dispute_at timestamptz,
	state text check (state in ('paid', 'failed', 'packed', 'on_the_way', 'delivered', 'cancelled')),
	state_at timestamptz,
	-- A kind, never a name.
	state_by text check (state_by in ('stripe', 'agent', 'member')),
	made_at timestamptz not null,
	changed_at timestamptz not null,
	-- What the upkeep last added to qorpera_order_days for this order; `rolled` is false while a change is not added.
	rolled boolean not null default false,
	rolled_day date,
	rolled_currency text check (rolled_currency ~ '^[a-z]{3}$'),
	rolled_orders integer not null default 0 check (rolled_orders in (0, 1)),
	rolled_sales_minor bigint not null default 0 check (rolled_sales_minor >= 0),
	rolled_refunds_minor bigint not null default 0 check (rolled_refunds_minor >= 0),
	unique (profile_id, live, ref_sha256),
	check ((dispute is null) = (dispute_at is null)),
	check ((state is null) = (state_at is null) and (state is null) = (state_by is null)),
	-- A row with a state is a whole order: when, in what currency, how much.
	check (state is null or (ordered_at is not null and currency is not null and amount_minor is not null)),
	check ((rolled_day is null) = (rolled_currency is null))
);
create index qorpera_orders_company on public.qorpera_orders(profile_id, environment_id, live, ordered_at);
create index qorpera_orders_unrolled on public.qorpera_orders(changed_at) where not rolled;
create index qorpera_orders_age on public.qorpera_orders((coalesce(ordered_at, made_at)));
create index qorpera_orders_hook on public.qorpera_orders(hook_id);
-- The orders the company gave a state of its own: to_pack's start is their earliest (an indexed min).
create index qorpera_orders_marked on public.qorpera_orders(profile_id, environment_id, live, ordered_at)
	where state in ('packed', 'on_the_way', 'delivered', 'cancelled');

create table public.qorpera_order_days (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	environment_id uuid not null references public.qorpera_company_environments(id) on delete cascade,
	live boolean not null,
	-- The company's calendar day of the orders, in its zone when they were added.
	day date not null,
	currency text not null check (currency ~ '^[a-z]{3}$'),
	orders bigint not null check (orders >= 0),
	sales_minor bigint not null check (sales_minor >= 0),
	refunds_minor bigint not null check (refunds_minor >= 0),
	primary key (profile_id, environment_id, live, day, currency)
);

create table public.qorpera_order_retries (
	delivery_id uuid primary key references public.qorpera_event_deliveries(id) on delete cascade,
	profile_id uuid not null,
	since timestamptz not null,
	attempts integer not null default 0 check (attempts >= 0)
);
create index qorpera_order_retries_since on public.qorpera_order_retries(since);

create table public.qorpera_order_upkeep (
	id boolean primary key default true check (id),
	ran_at timestamptz,
	stopped text check (stopped is null or stopped in ('done', 'busy', 'lock_timeout'))
);
insert into public.qorpera_order_upkeep (id) values (true);

alter table public.qorpera_orders enable row level security;
alter table public.qorpera_order_days enable row level security;
alter table public.qorpera_order_retries enable row level security;
alter table public.qorpera_order_upkeep enable row level security;
revoke all on public.qorpera_orders, public.qorpera_order_days, public.qorpera_order_retries,
	public.qorpera_order_upkeep from public, anon, authenticated, service_role, qorpera_secret_broker;
comment on table public.qorpera_orders is
	'20260930776000: a company''s orders, one row a Stripe payment (a hash of its id), made by a trigger when a Stripe '
	'hook''s delivery is verified: when, how much, refunded, dispute, state. No buyer''s data. Kept 400 days.';
comment on table public.qorpera_order_days is
	'20260930776000: orders, sales and refunds by the company''s day, mode and currency, added by '
	'qorpera_order_upkeep; kept as long as the company.';
comment on table public.qorpera_order_retries is
	'20260930776000: verified Stripe deliveries whose order row was locked when they came, retried by '
	'qorpera_order_upkeep while their body is kept.';
comment on table public.qorpera_order_upkeep is '20260930776000: qorpera_order_upkeep''s last run.';

-- 2. From a verified delivery to an order -------------------------------------------------------------------------------

-- The order's key: sha256 of '<company id>:<Stripe id>'. Stripe's id itself is never kept.
create function public.qorpera_order_ref_sha256(p_profile_id uuid, p_ref text) returns text
language sql immutable set search_path = '' as $$
	-- 20260930776000
	select encode(extensions.digest(convert_to(p_profile_id::text || ':' || p_ref, 'utf8'), 'sha256'), 'hex')
$$;

-- A Stripe time (seconds since 1970, a whole number); null for anything else.
create function public.qorpera_order_stripe_time(p_value jsonb) returns timestamptz
language sql immutable set search_path = '' as $$
	-- 20260930776000
	select case when jsonb_typeof(p_value) = 'number' and (p_value #>> '{}') ~ '^[0-9]{9,11}$'
		then to_timestamp((p_value #>> '{}')::bigint) end
$$;

-- A Stripe amount in minor units (a whole number, at most 15 digits); null for anything else.
create function public.qorpera_order_stripe_minor(p_value jsonb) returns bigint
language sql immutable set search_path = '' as $$
	-- 20260930776000
	select case when jsonb_typeof(p_value) = 'number' and (p_value #>> '{}') ~ '^[0-9]{1,15}$'
		then (p_value #>> '{}')::bigint end
$$;

-- A Stripe id of the given prefix (pi, cs); null for anything else.
create function public.qorpera_order_stripe_id(p_value jsonb, p_prefix text) returns text
language sql immutable set search_path = '' as $$
	-- 20260930776000
	select case when jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') ~ ('^' || p_prefix || '_[A-Za-z0-9_]{1,250}$')
		then p_value #>> '{}' end
$$;

-- One verified delivery of a Stripe hook as an order fact: 'applied', or 'ignored' (not a Stripe hook's verified
-- delivery with a body, not JSON, a type or field this door does not take). Waits at most 100 ms for a lock and then
-- raises lock_not_available, for the caller to retry later.
create function public.qorpera_order_fact(p_delivery public.qorpera_event_deliveries) returns text
language plpgsql volatile set search_path = '' set lock_timeout = '100ms' as $$
-- 20260930776000
declare
	v_hook public.qorpera_event_hooks%rowtype;
	v_event jsonb;
	v_object jsonb;
	v_type text;
	v_live boolean;
	v_at timestamptz;
	v_ref text;
	v_ordered_at timestamptz;
	v_currency text;
	v_amount bigint;
	v_refunded bigint;
	v_dispute text;
	v_state text;
	v_now timestamptz := clock_timestamp();
begin
	if p_delivery.status is distinct from 'verified' or p_delivery.body is null then return 'ignored'; end if;
	select hook.* into v_hook from public.qorpera_event_hooks as hook
	where hook.id = p_delivery.hook_id and hook.proof = 'stripe' and hook.profile_id = p_delivery.profile_id;
	if not found then return 'ignored'; end if;
	begin
		v_event := convert_from(p_delivery.body, 'UTF8')::jsonb;
	exception when others then
		return 'ignored';
	end;
	if jsonb_typeof(v_event) is distinct from 'object' or jsonb_typeof(v_event -> 'type') is distinct from 'string'
		or jsonb_typeof(v_event #> '{data,object}') is distinct from 'object' then
		return 'ignored'; end if;
	v_type := v_event ->> 'type';
	v_object := v_event #> '{data,object}';
	if jsonb_typeof(v_object -> 'livemode') is distinct from 'boolean' then return 'ignored'; end if;
	v_live := (v_object ->> 'livemode')::boolean;
	-- When the fact happened: the event's time, or the verification's when it has none.
	v_at := coalesce(public.qorpera_order_stripe_time(v_event -> 'created'), p_delivery.verified_at, v_now);

	if v_type in ('checkout.session.completed', 'checkout.session.async_payment_succeeded',
			'checkout.session.async_payment_failed') then
		if v_object ->> 'mode' is distinct from 'payment' then
			return 'ignored'; end if;
		v_ref := coalesce(public.qorpera_order_stripe_id(v_object -> 'payment_intent', 'pi'),
			public.qorpera_order_stripe_id(v_object -> 'id', 'cs'));
		v_ordered_at := public.qorpera_order_stripe_time(v_object -> 'created');
		v_amount := public.qorpera_order_stripe_minor(v_object -> 'amount_total');
		if jsonb_typeof(v_object -> 'currency') = 'string' and (v_object ->> 'currency') ~ '^[A-Za-z]{3}$' then
			v_currency := lower(v_object ->> 'currency'); end if;
		if v_ref is null or v_ordered_at is null or v_amount is null or v_currency is null then return 'ignored'; end if;
		v_state := case v_type
			when 'checkout.session.async_payment_succeeded' then 'paid'
			when 'checkout.session.async_payment_failed' then 'failed'
			else case when v_object ->> 'payment_status' in ('paid', 'no_payment_required') then 'paid' end end;
	elsif v_type = 'charge.refunded' then
		v_ref := public.qorpera_order_stripe_id(v_object -> 'payment_intent', 'pi');
		v_refunded := public.qorpera_order_stripe_minor(v_object -> 'amount_refunded');
		if v_ref is null or v_refunded is null then return 'ignored'; end if;
	elsif v_type in ('charge.dispute.created', 'charge.dispute.closed') then
		v_ref := public.qorpera_order_stripe_id(v_object -> 'payment_intent', 'pi');
		v_dispute := case when v_type = 'charge.dispute.created' then 'open'
			when v_object ->> 'status' in ('won', 'warning_closed') then 'won'
			when v_object ->> 'status' = 'lost' then 'lost' end;
		if v_ref is null or v_dispute is null then return 'ignored'; end if;
	else
		return 'ignored';
	end if;

	insert into public.qorpera_orders as kept (profile_id, environment_id, hook_id, source, live, ref_sha256, ordered_at,
		currency, amount_minor, refunded_minor, dispute, dispute_at, state, state_at, state_by, made_at, changed_at)
	values (v_hook.profile_id, v_hook.environment_id, v_hook.id, 'stripe', v_live,
		public.qorpera_order_ref_sha256(v_hook.profile_id, v_ref), v_ordered_at, v_currency, v_amount,
		coalesce(v_refunded, 0), v_dispute, case when v_dispute is not null then v_at end, v_state,
		case when v_state is not null then v_at end, case when v_state is not null then 'stripe' end, v_now, v_now)
	on conflict (profile_id, live, ref_sha256) do update set
		hook_id = coalesce(kept.hook_id, excluded.hook_id),
		-- The session's facts, once: a refund or a dispute that came first left them empty.
		ordered_at = coalesce(kept.ordered_at, excluded.ordered_at),
		currency = coalesce(kept.currency, excluded.currency),
		amount_minor = coalesce(kept.amount_minor, excluded.amount_minor),
		-- Stripe's running total: the largest seen.
		refunded_minor = greatest(kept.refunded_minor, excluded.refunded_minor),
		-- A dispute moves only to a newer event's; a close beats an open of the same second.
		dispute = case when excluded.dispute is not null and (kept.dispute_at is null
				or excluded.dispute_at > kept.dispute_at
				or (excluded.dispute_at = kept.dispute_at and excluded.dispute <> 'open'))
			then excluded.dispute else kept.dispute end,
		dispute_at = case when excluded.dispute is not null and (kept.dispute_at is null
				or excluded.dispute_at > kept.dispute_at
				or (excluded.dispute_at = kept.dispute_at and excluded.dispute <> 'open'))
			then excluded.dispute_at else kept.dispute_at end,
		-- Paid only over nothing or failed; failed only over nothing. The company's states are its own.
		state = case when (excluded.state = 'paid' and (kept.state is null or kept.state = 'failed'))
				or (excluded.state = 'failed' and kept.state is null)
			then excluded.state else kept.state end,
		state_at = case when (excluded.state = 'paid' and (kept.state is null or kept.state = 'failed'))
				or (excluded.state = 'failed' and kept.state is null)
			then excluded.state_at else kept.state_at end,
		state_by = case when (excluded.state = 'paid' and (kept.state is null or kept.state = 'failed'))
				or (excluded.state = 'failed' and kept.state is null)
			then excluded.state_by else kept.state_by end,
		changed_at = excluded.changed_at,
		rolled = false;
	return 'applied';
end $$;

-- The trigger: a verified delivery of a Stripe hook makes or changes its order. It never fails the verification.
create function public.qorpera_order_from_delivery() returns trigger
language plpgsql security definer set search_path = '' as $$
-- 20260930776000
begin
	begin
		perform public.qorpera_order_fact(new);
	exception
		when lock_not_available or deadlock_detected then
			begin
				insert into public.qorpera_order_retries (delivery_id, profile_id, since)
				values (new.id, new.profile_id, clock_timestamp())
				on conflict (delivery_id) do nothing;
			exception when others then
				null;
			end;
		when others then
			null;
	end;
	return null;
end $$;

create trigger qorpera_orders_from_stripe
	after update of status on public.qorpera_event_deliveries
	for each row when (new.status = 'verified' and old.status is distinct from 'verified')
	execute function public.qorpera_order_from_delivery();
comment on trigger qorpera_orders_from_stripe on public.qorpera_event_deliveries is
	'20260930776000: a Stripe hook''s verified delivery makes or changes its counts-only order (qorpera_orders); '
	'never fails the verification.';

-- 3. The back-fill -----------------------------------------------------------------------------------------------------

-- Every verified delivery of a Stripe hook whose body is still kept, oldest first. A locked order is left to the upkeep.
create function public.qorpera_order_backfill() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
-- 20260930776000
declare v_delivery public.qorpera_event_deliveries%rowtype; v_applied integer := 0; v_ignored integer := 0;
	v_busy integer := 0;
begin
	for v_delivery in select delivery.* from public.qorpera_event_deliveries as delivery
		join public.qorpera_event_hooks as hook on hook.id = delivery.hook_id and hook.proof = 'stripe'
		where delivery.status = 'verified' and delivery.body is not null
		order by delivery.verified_at, delivery.id loop
		begin
			if public.qorpera_order_fact(v_delivery) = 'applied' then v_applied := v_applied + 1;
			else v_ignored := v_ignored + 1; end if;
		exception
			when lock_not_available or deadlock_detected then
				insert into public.qorpera_order_retries (delivery_id, profile_id, since)
				values (v_delivery.id, v_delivery.profile_id, clock_timestamp())
				on conflict (delivery_id) do nothing;
				v_busy := v_busy + 1;
			when others then
				v_ignored := v_ignored + 1;
		end;
	end loop;
	return jsonb_build_object('schema', 'qorpera.order-backfill/v1', 'applied', v_applied, 'ignored', v_ignored,
		'busy', v_busy);
end $$;

-- 4. The upkeep --------------------------------------------------------------------------------------------------------

-- Retries what was missed (at most 1000 a run), adds each changed order's difference to its day in the company's zone
-- now (at most 10000 a run), then deletes order rows 400 days after the order. One run at a time; each step that waits
-- more than a second for a lock is undone for the next run. p_now: a test's clock (pg_cron passes none).
create function public.qorpera_order_upkeep(p_now timestamptz default null) returns jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '1s' as $$
-- 20260930776000
declare
	v_now timestamptz := coalesce(p_now, clock_timestamp());
	v_retry record;
	v_delivery public.qorpera_event_deliveries%rowtype;
	v_retried integer := 0;
	v_waiting integer := 0;
	v_dropped integer := 0;
	v_fresh jsonb;
	v_rolled integer := 0;
	v_deleted integer := 0;
	v_stopped text := 'done';
begin
	if not pg_try_advisory_xact_lock(hashtextextended('qorpera.order-upkeep', 0)) then
		return jsonb_build_object('schema', 'qorpera.order-upkeep/v1', 'stopped', 'busy'); end if;

	-- Retries: a delivery whose body is gone (or that is no longer verified) is dropped; one still locked waits.
	begin
		for v_retry in select retry.delivery_id from public.qorpera_order_retries as retry
			order by retry.since, retry.delivery_id limit 1000 for update skip locked loop
			select delivery.* into v_delivery from public.qorpera_event_deliveries as delivery
			where delivery.id = v_retry.delivery_id;
			if not found or v_delivery.status <> 'verified' or v_delivery.body is null then
				delete from public.qorpera_order_retries where delivery_id = v_retry.delivery_id;
				v_dropped := v_dropped + 1;
				continue;
			end if;
			begin
				perform public.qorpera_order_fact(v_delivery);
				delete from public.qorpera_order_retries where delivery_id = v_retry.delivery_id;
				v_retried := v_retried + 1;
			exception
				when lock_not_available or deadlock_detected then
					update public.qorpera_order_retries set attempts = attempts + 1 where delivery_id = v_retry.delivery_id;
					v_waiting := v_waiting + 1;
				when others then
					delete from public.qorpera_order_retries where delivery_id = v_retry.delivery_id;
					v_dropped := v_dropped + 1;
			end;
		end loop;
	exception when lock_not_available then
		v_stopped := 'lock_timeout'; v_retried := 0; v_waiting := 0; v_dropped := 0;
	end;

	-- Days: each changed order's difference (what it counts now less what was added for it), locked rows left for the
	-- next run. An order counts once paid: on its day in the company's zone, with its amount and what was refunded of it.
	begin
		with dirty as materialized (
			select o.id, o.profile_id, o.environment_id, o.live, o.ordered_at, o.currency, o.amount_minor,
				o.refunded_minor, o.state, o.rolled_day, o.rolled_currency, o.rolled_orders, o.rolled_sales_minor,
				o.rolled_refunds_minor
			from public.qorpera_orders as o where not o.rolled order by o.changed_at limit 10000 for update skip locked
		), zones as (
			select company.profile_id, public.qorpera_company_numbers_zone(company.profile_id) as zone
			from (select distinct dirty.profile_id from dirty) as company
		)
		select coalesce(jsonb_agg(jsonb_build_object('id', dirty.id, 'profile_id', dirty.profile_id,
			'environment_id', dirty.environment_id, 'live', dirty.live,
			'new_day', case when dirty.state in ('paid', 'packed', 'on_the_way', 'delivered', 'cancelled')
				then (dirty.ordered_at at time zone zones.zone)::date end,
			'new_currency', case when dirty.state in ('paid', 'packed', 'on_the_way', 'delivered', 'cancelled')
				then dirty.currency end,
			'new_sales', dirty.amount_minor, 'new_refunds', least(dirty.refunded_minor, dirty.amount_minor),
			'old_day', dirty.rolled_day, 'old_currency', dirty.rolled_currency, 'old_orders', dirty.rolled_orders,
			'old_sales', dirty.rolled_sales_minor, 'old_refunds', dirty.rolled_refunds_minor)), '[]'::jsonb)
		into v_fresh
		from dirty join zones on zones.profile_id = dirty.profile_id;

		update public.qorpera_orders as o set rolled = true, rolled_day = fresh.new_day,
			rolled_currency = fresh.new_currency,
			rolled_orders = case when fresh.new_day is not null then 1 else 0 end,
			rolled_sales_minor = case when fresh.new_day is not null then fresh.new_sales else 0 end,
			rolled_refunds_minor = case when fresh.new_day is not null then fresh.new_refunds else 0 end
		from jsonb_to_recordset(v_fresh) as fresh(id uuid, new_day date, new_currency text, new_sales bigint,
			new_refunds bigint)
		where o.id = fresh.id;
		get diagnostics v_rolled = row_count;

		with fresh as (
			select * from jsonb_to_recordset(v_fresh) as fresh(profile_id uuid, environment_id uuid, live boolean,
				new_day date, new_currency text, new_sales bigint, new_refunds bigint, old_day date, old_currency text,
				old_orders integer, old_sales bigint, old_refunds bigint)
		), moves as (
			select fresh.profile_id, fresh.environment_id, fresh.live, fresh.new_day as day,
				fresh.new_currency as currency, 1::bigint as orders, fresh.new_sales as sales, fresh.new_refunds as refunds
			from fresh where fresh.new_day is not null
			union all
			select fresh.profile_id, fresh.environment_id, fresh.live, fresh.old_day, fresh.old_currency,
				-fresh.old_orders, -fresh.old_sales, -fresh.old_refunds
			from fresh where fresh.old_day is not null
		), summed as (
			select moves.profile_id, moves.environment_id, moves.live, moves.day, moves.currency,
				sum(moves.orders)::bigint as orders, sum(moves.sales)::bigint as sales, sum(moves.refunds)::bigint as refunds
			from moves
			group by moves.profile_id, moves.environment_id, moves.live, moves.day, moves.currency
			having sum(moves.orders) <> 0 or sum(moves.sales) <> 0 or sum(moves.refunds) <> 0
		), changed as (
			update public.qorpera_order_days as kept set orders = kept.orders + summed.orders,
				sales_minor = kept.sales_minor + summed.sales, refunds_minor = kept.refunds_minor + summed.refunds
			from summed
			where kept.profile_id = summed.profile_id and kept.environment_id = summed.environment_id
				and kept.live = summed.live and kept.day = summed.day and kept.currency = summed.currency
			returning kept.profile_id, kept.environment_id, kept.live, kept.day, kept.currency
		)
		insert into public.qorpera_order_days (profile_id, environment_id, live, day, currency, orders, sales_minor,
			refunds_minor)
		select summed.profile_id, summed.environment_id, summed.live, summed.day, summed.currency, summed.orders,
			summed.sales, summed.refunds
		from summed
		where not exists (select 1 from changed
			where changed.profile_id = summed.profile_id and changed.environment_id = summed.environment_id
				and changed.live = summed.live and changed.day = summed.day and changed.currency = summed.currency);
	exception when lock_not_available then
		v_stopped := 'lock_timeout'; v_rolled := 0;
	end;

	-- Order rows 400 days after the order (a row without one, 400 days after it was made), once added to their day.
	begin
		delete from public.qorpera_orders as o
		where o.rolled and coalesce(o.ordered_at, o.made_at) < v_now - interval '400 days';
		get diagnostics v_deleted = row_count;
	exception when lock_not_available then
		v_stopped := 'lock_timeout'; v_deleted := 0;
	end;

	update public.qorpera_order_upkeep set ran_at = clock_timestamp(), stopped = v_stopped;
	return jsonb_build_object('schema', 'qorpera.order-upkeep/v1', 'stopped', v_stopped, 'retried', v_retried,
		'retryWaiting', v_waiting, 'retryDropped', v_dropped, 'rolled', v_rolled, 'deleted', v_deleted);
end $$;

-- Where pg_cron is absent or the role may not use it, nothing is scheduled and the migration still applies. Scheduling
-- by the same name replaces that one job.
create function public.qorpera_schedule_order_upkeep() returns jsonb
language plpgsql set search_path = '' as $$
-- 20260930776000
declare v_job bigint;
begin
	if to_regnamespace('cron') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
		raise notice 'Orders upkeep was not scheduled: pg_cron is not installed here';
		return jsonb_build_object('schema', 'qorpera.order-upkeep-schedule/v1', 'scheduled', false);
	end if;
	begin
		v_job := cron.schedule('qorpera-orders', '*/10 * * * *', 'select public.qorpera_order_upkeep()');
	exception when others then
		raise warning 'Orders upkeep was not scheduled (%): % may not use pg_cron', sqlerrm, current_user;
		return jsonb_build_object('schema', 'qorpera.order-upkeep-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.order-upkeep-schedule/v1', 'scheduled', true, 'job', v_job);
end $$;

-- 5. The orders questions ----------------------------------------------------------------------------------------------

-- Who may read the orders questions: the one place this rule lives. The founder, 15 November 2026 (DESIGN-5-orders.md
-- §E): everyone in the company, as site visits; the dispatcher's two doors already admit only a member of the company
-- or a run of it, so this adds nothing to them. "Only those who may see the bank" would be this one line instead:
--   select public.qorpera_folder_actor_allowed(p_environment_id, p_profile_id, p_actor, 'bank/summary.json', 'read')
create function public.qorpera_company_numbers_orders_readable(p_environment_id uuid, p_profile_id uuid,
	p_actor jsonb) returns boolean
language sql stable set search_path = '' as $$
	-- 20260930776000
	select p_environment_id is not null and p_profile_id is not null and p_actor is not null
$$;

-- Minor units as a JSON number in the currency's major unit: Stripe's zero-decimal currencies whole, its three-decimal
-- ones with three decimals, the rest with two.
create function public.qorpera_order_major(p_minor numeric, p_currency text) returns jsonb
language sql immutable set search_path = '' as $$
	-- 20260930776000
	select case
		when p_minor is null then 'null'::jsonb
		when p_currency in ('bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv',
			'xaf', 'xof', 'xpf') then to_jsonb(round(p_minor))
		when p_currency in ('bhd', 'jod', 'kwd', 'omr', 'tnd') then to_jsonb(round(p_minor / 1000, 3))
		else to_jsonb(round(p_minor / 100, 2)) end
$$;

-- Orders, sales and refunds (minor units) a day of the company's, p_from to p_to, in one mode and currency: the days
-- the upkeep added, and each changed order's difference it has not added yet.
create function public.qorpera_order_day_rows(p_profile_id uuid, p_environment_id uuid, p_live boolean,
	p_currency text, p_zone text, p_from date, p_to date)
returns table (day date, orders bigint, sales_minor numeric, refunds_minor numeric)
language sql stable set search_path = '' as $$
	-- 20260930776000
	select moved.day, sum(moved.orders)::bigint, sum(moved.sales), sum(moved.refunds) from (
		select kept.day, kept.orders, kept.sales_minor::numeric as sales, kept.refunds_minor::numeric as refunds
		from public.qorpera_order_days as kept
		where kept.profile_id = p_profile_id and kept.environment_id = p_environment_id and kept.live = p_live
			and kept.currency = p_currency and kept.day between p_from and p_to
		union all
		select (o.ordered_at at time zone p_zone)::date, 1, o.amount_minor, least(o.refunded_minor, o.amount_minor)
		from public.qorpera_orders as o
		where o.profile_id = p_profile_id and o.environment_id = p_environment_id and o.live = p_live and not o.rolled
			and o.state in ('paid', 'packed', 'on_the_way', 'delivered', 'cancelled') and o.currency = p_currency
			and o.ordered_at >= (p_from - 2)::timestamp at time zone 'UTC'
			and o.ordered_at < (p_to + 3)::timestamp at time zone 'UTC'
			and (o.ordered_at at time zone p_zone)::date between p_from and p_to
		union all
		select o.rolled_day, -o.rolled_orders, -o.rolled_sales_minor, -o.rolled_refunds_minor
		from public.qorpera_orders as o
		where o.profile_id = p_profile_id and o.environment_id = p_environment_id and o.live = p_live and not o.rolled
			and o.rolled_currency = p_currency and o.rolled_day between p_from and p_to
	) as moved
	group by moved.day
$$;

-- An orders question's {columns, rows, more} for the company at p_now. Rights are decided before (the doors and
-- qorpera_company_numbers_orders_readable); p_params is an object.
create function public.qorpera_company_numbers_orders(p_environment_id uuid, p_profile_id uuid, p_now timestamptz,
	p_question text, p_params jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
-- 20260930776000
declare
	c_orders constant text[] := array['paid', 'packed', 'on_the_way', 'delivered', 'cancelled'];
	v_zone text := public.qorpera_company_numbers_zone(p_profile_id);
	v_today date;
	v_now_hour timestamptz := date_trunc('hour', p_now, 'UTC');
	v_takes text[];
	v_key text;
	v_live boolean := true;
	v_currency text;
	v_from date;
	v_to date;
	v_hour_from timestamptz;
	v_hour_to timestamptz;
	v_stripe text;
	v_marked_since timestamptz;
	v_columns text[];
	v_rows jsonb;
begin
	v_today := (p_now at time zone v_zone)::date;
	v_takes := case p_question
		when 'orders-now' then array['currency', 'test']
		when 'orders-hours' then array['currency', 'test', 'from', 'to']
		when 'orders-days' then array['currency', 'test', 'from', 'to']
		when 'orders-months' then array['currency', 'test']
		when 'orders-states' then array['currency', 'test', 'from', 'to'] end;
	for v_key in select k from jsonb_object_keys(p_params) k order by k loop
		if not v_key = any (v_takes) then
			raise exception 'The question takes no :%', left(v_key, 60) using errcode = '22023'; end if;
	end loop;
	-- Test orders only when asked.
	if p_params ? 'test' and jsonb_typeof(p_params -> 'test') <> 'null' then
		if p_params -> 'test' in ('true'::jsonb, '"true"'::jsonb) then v_live := false;
		elsif p_params -> 'test' not in ('false'::jsonb, '"false"'::jsonb) then
			raise exception ':test is true or false' using errcode = '22023'; end if;
	end if;
	-- The currency asked, or the one of most of the mode's orders in the last 90 days, else Danish kroner.
	if p_params ? 'currency' and jsonb_typeof(p_params -> 'currency') <> 'null' then
		if jsonb_typeof(p_params -> 'currency') <> 'string' or (p_params ->> 'currency') !~ '^[A-Za-z]{3}$' then
			raise exception ':currency is a currency''s three letters, as DKK' using errcode = '22023'; end if;
		v_currency := lower(p_params ->> 'currency');
	else
		select o.currency into v_currency from public.qorpera_orders as o
		where o.profile_id = p_profile_id and o.environment_id = p_environment_id and o.live = v_live
			and o.state = any (c_orders) and o.ordered_at >= p_now - interval '90 days'
		group by o.currency order by count(*) desc, o.currency collate "C" limit 1;
		v_currency := coalesce(v_currency, 'dkk');
	end if;
	-- The day range of orders-days and orders-states: by default the 30 days to today; from a :from, at most its 400
	-- days and never past today, nor before it.
	if p_question in ('orders-days', 'orders-states') then
		v_from := public.qorpera_company_numbers_day(p_params, 'from');
		v_to := coalesce(public.qorpera_company_numbers_day(p_params, 'to'),
			case when v_from is not null then greatest(v_from, least(v_from + 399, v_today)) else v_today end);
		v_from := coalesce(v_from, v_to - 29);
		if v_from > v_to then raise exception ':from is after :to' using errcode = '22023'; end if;
		if v_to - v_from + 1 > 400 then
			raise exception 'From :from to :to is at most 400 days' using errcode = '22023'; end if;
		-- orders-states reads the order rows, which go 400 days after the order: no further back.
		if p_question = 'orders-states' and v_from < v_today - 399 then
			raise exception 'qorpera/orders-states reaches 400 days back: :from is from %', v_today - 399
				using errcode = '22023'; end if;
	end if;

	case p_question
	when 'orders-now' then
		v_stripe := case
			when not exists (select 1 from public.qorpera_event_hooks as hook
				where hook.profile_id = p_profile_id and hook.environment_id = p_environment_id and hook.proof = 'stripe'
					and hook.status <> 'removed') then 'none'
			when exists (select 1 from public.qorpera_orders as o
					where o.profile_id = p_profile_id and o.environment_id = p_environment_id)
				or exists (select 1 from public.qorpera_event_hooks as hook
					join public.qorpera_event_hook_capture_keys as capture on capture.hook_id = hook.id
					where hook.profile_id = p_profile_id and hook.environment_id = p_environment_id
						and hook.proof = 'stripe' and capture.verified_secret_version is not null)
				or exists (select 1 from public.qorpera_event_hooks as hook
					join public.qorpera_event_deliveries as delivery on delivery.hook_id = hook.id
					where hook.profile_id = p_profile_id and hook.environment_id = p_environment_id
						and hook.proof = 'stripe' and delivery.status = 'verified') then 'live'
			else 'waiting' end;
		-- to_pack starts at the first order of this mode the company gave a state of its own: what came before it was
		-- never marked and is not waiting to be packed.
		select min(o.ordered_at) into v_marked_since from public.qorpera_orders as o
		where o.profile_id = p_profile_id and o.environment_id = p_environment_id and o.live = v_live
			and o.state in ('packed', 'on_the_way', 'delivered', 'cancelled');
		v_columns := array['stripe', 'orders_today', 'sales_today', 'to_pack', 'on_the_way', 'refunds_30d',
			'disputes_open', 'last_order_at'];
		select jsonb_build_array(v_stripe,
			count(*) filter (where o.state = any (c_orders) and o.currency = v_currency
				and o.ordered_at >= v_today::timestamp at time zone v_zone
				and o.ordered_at < (v_today + 1)::timestamp at time zone v_zone),
			public.qorpera_order_major(coalesce(sum(o.amount_minor) filter (where o.state = any (c_orders)
				and o.currency = v_currency and o.ordered_at >= v_today::timestamp at time zone v_zone
				and o.ordered_at < (v_today + 1)::timestamp at time zone v_zone), 0), v_currency),
			-- Null for a company that set no state of its own in 90 days: "to pack" never grows for nobody.
			case when bool_or(o.state in ('packed', 'on_the_way', 'delivered', 'cancelled')
					and o.state_at >= p_now - interval '90 days')
				then count(*) filter (where o.state = 'paid' and o.ordered_at >= v_marked_since
					and (o.refunded_minor < o.amount_minor or o.amount_minor = 0)) end,
			count(*) filter (where o.state = 'on_the_way'),
			public.qorpera_order_major(coalesce(sum(least(o.refunded_minor, o.amount_minor)) filter (
				where o.state = any (c_orders) and o.currency = v_currency
					and o.ordered_at >= (v_today - 29)::timestamp at time zone v_zone
					and o.ordered_at < (v_today + 1)::timestamp at time zone v_zone), 0), v_currency),
			count(*) filter (where o.dispute = 'open'),
			to_char(max(o.ordered_at) filter (where o.state = any (c_orders)) at time zone 'UTC',
				'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
		into v_rows
		from public.qorpera_orders as o
		where o.profile_id = p_profile_id and o.environment_id = p_environment_id and o.live = v_live;
		v_rows := jsonb_build_array(v_rows);
	when 'orders-hours' then
		-- By default the 48 hours to this one; from a :from, at most its 168 hours and never past this hour, nor before it.
		v_hour_from := public.qorpera_company_numbers_hour(p_params, 'from', v_zone, false);
		v_hour_to := coalesce(public.qorpera_company_numbers_hour(p_params, 'to', v_zone, true),
			case when v_hour_from is not null
				then greatest(v_hour_from, least(v_hour_from + interval '167 hours', v_now_hour)) else v_now_hour end);
		v_hour_from := coalesce(v_hour_from, v_hour_to - interval '47 hours');
		if v_hour_from > v_hour_to then raise exception ':from is after :to' using errcode = '22023'; end if;
		-- Two days named: at most 7 of the company's days, a week with its 25-hour day too; times: at most 168 hours.
		if (p_params ->> 'from') ~ '^\d{4}-\d{2}-\d{2}$' and (p_params ->> 'to') ~ '^\d{4}-\d{2}-\d{2}$' then
			if (p_params ->> 'to')::date - (p_params ->> 'from')::date > 6 then
				raise exception 'From :from to :to is at most 7 days' using errcode = '22023'; end if;
		elsif v_hour_to - v_hour_from > interval '167 hours' then
			raise exception 'From :from to :to is at most 7 days' using errcode = '22023'; end if;
		v_columns := array['hour', 'hour_local', 'orders', 'sales'];
		select jsonb_agg(jsonb_build_array(to_char(series.hour at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
			to_char(series.hour at time zone v_zone, 'YYYY-MM-DD"T"HH24:MI'), coalesce(counted.orders, 0),
			public.qorpera_order_major(coalesce(counted.sales, 0), v_currency)) order by series.hour)
		into v_rows
		from generate_series(v_hour_from, v_hour_to, interval '1 hour') as series(hour)
		left join (select date_trunc('hour', o.ordered_at, 'UTC') as hour, count(*) as orders,
				sum(o.amount_minor) as sales
			from public.qorpera_orders as o
			where o.profile_id = p_profile_id and o.environment_id = p_environment_id and o.live = v_live
				and o.state = any (c_orders) and o.currency = v_currency
				and o.ordered_at >= v_hour_from and o.ordered_at < v_hour_to + interval '1 hour'
			group by 1) as counted on counted.hour = series.hour;
	when 'orders-days' then
		v_columns := array['day', 'orders', 'sales', 'refunds'];
		select jsonb_agg(jsonb_build_array(to_char(series.day, 'YYYY-MM-DD'), coalesce(counted.orders, 0),
			public.qorpera_order_major(coalesce(counted.sales_minor, 0), v_currency),
			public.qorpera_order_major(coalesce(counted.refunds_minor, 0), v_currency)) order by series.day)
		into v_rows
		from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') as series(day)
		left join public.qorpera_order_day_rows(p_profile_id, p_environment_id, v_live, v_currency, v_zone, v_from, v_to)
			as counted on counted.day = series.day::date;
	when 'orders-months' then
		v_from := (date_trunc('month', v_today::timestamp) - interval '11 months')::date;
		v_columns := array['month', 'orders', 'sales', 'refunds'];
		select jsonb_agg(jsonb_build_array(to_char(series.month, 'YYYY-MM'), coalesce(counted.orders, 0),
			public.qorpera_order_major(coalesce(counted.sales, 0), v_currency),
			public.qorpera_order_major(coalesce(counted.refunds, 0), v_currency)) order by series.month)
		into v_rows
		from generate_series(v_from::timestamp, date_trunc('month', v_today::timestamp)::timestamp, interval '1 month')
			as series(month)
		left join (select date_trunc('month', day_row.day::timestamp)::date as month, sum(day_row.orders)::bigint as orders,
				sum(day_row.sales_minor) as sales, sum(day_row.refunds_minor) as refunds
			from public.qorpera_order_day_rows(p_profile_id, p_environment_id, v_live, v_currency, v_zone, v_from,
				v_today) as day_row
			group by 1) as counted on counted.month = series.month::date;
	when 'orders-states' then
		v_columns := array['state', 'orders', 'amount'];
		select jsonb_agg(jsonb_build_array(listed.state, coalesce(counted.orders, 0),
			public.qorpera_order_major(coalesce(counted.amount, 0), v_currency)) order by listed.place)
		into v_rows
		from (values ('paid', 1), ('packed', 2), ('on_the_way', 3), ('delivered', 4), ('cancelled', 5), ('failed', 6))
			as listed(state, place)
		left join (select o.state, count(*) as orders, sum(o.amount_minor) as amount
			from public.qorpera_orders as o
			where o.profile_id = p_profile_id and o.environment_id = p_environment_id and o.live = v_live
				and o.currency = v_currency
				and o.ordered_at >= v_from::timestamp at time zone v_zone
				and o.ordered_at < (v_to + 1)::timestamp at time zone v_zone
			group by o.state) as counted on counted.state = listed.state;
	end case;

	return jsonb_build_object('columns', to_jsonb(v_columns), 'rows', coalesce(v_rows, '[]'::jsonb), 'more', false);
end $$;

revoke all on function public.qorpera_order_ref_sha256(uuid, text),
	public.qorpera_order_stripe_time(jsonb),
	public.qorpera_order_stripe_minor(jsonb),
	public.qorpera_order_stripe_id(jsonb, text),
	public.qorpera_order_fact(public.qorpera_event_deliveries),
	public.qorpera_order_from_delivery(),
	public.qorpera_order_backfill(),
	public.qorpera_order_upkeep(timestamptz),
	public.qorpera_schedule_order_upkeep(),
	public.qorpera_company_numbers_orders_readable(uuid, uuid, jsonb),
	public.qorpera_order_major(numeric, text),
	public.qorpera_order_day_rows(uuid, uuid, boolean, text, text, date, date),
	public.qorpera_company_numbers_orders(uuid, uuid, timestamptz, text, jsonb)
	from public, anon, authenticated, service_role, qorpera_secret_broker;

-- The dispatcher answers the orders questions, by an anchor on its definition as 20260930768000 left it (an anchor not
-- found exactly once fails the migration).
create function pg_temp.orders_patch(p_target regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if position('20260930776000' in v_definition) > 0 then
		raise exception '20260930776000 is already in %', p_target; end if;
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception '20260930776000 anchor is not found exactly once in %: %', p_target, left(p_old, 80); end if;
	execute replace(v_definition, p_old, p_new);
end $$;

select pg_temp.orders_patch('public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)'::regprocedure,
	$old$	-- 20260930768000: the site questions, for any member or run of the company (the two doors' own check), from the$old$,
	$new$	-- 20260930776000: the orders questions, for whoever qorpera_company_numbers_orders_readable admits (the one
	-- place that rule lives), from the orders Stripe hooks' verified deliveries made (qorpera_company_numbers_orders).
	if p_question in ('orders-now', 'orders-hours', 'orders-days', 'orders-months', 'orders-states') then
		if not coalesce(public.qorpera_company_numbers_orders_readable(p_environment_id, p_profile_id, p_actor), false) then
			raise exception 'No question qorpera/% that you may read', p_question using errcode = 'P0002'; end if;
		v_body := public.qorpera_company_numbers_orders(p_environment_id, p_profile_id, v_now, p_question, v_params);
		return v_body || jsonb_build_object(
			'asOf', to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
			'etag', left(encode(extensions.digest(convert_to(v_body::text, 'utf8'), 'sha256'), 'hex'), 32));
	end if;
	-- 20260930768000: the site questions, for any member or run of the company (the two doors' own check), from the$new$);

drop function pg_temp.orders_patch(regprocedure, text, text);

-- The dispatcher keeps its grants (none) and its markers.
do $$
declare v_source text := (select prosrc from pg_proc
	where oid = 'public.qorpera_company_numbers_answer(uuid,uuid,jsonb,text,jsonb)'::regprocedure);
begin
	if strpos(v_source, 'Company views step 3, slice M1 (20260930767000)') = 0 or strpos(v_source, '20260930768000') = 0
		or strpos(v_source, '20260930776000') = 0 then
		raise exception '20260930776000: the dispatcher lost a marker'; end if;
end $$;

-- The back-fill and the schedule last, once every piece is in place.
select public.qorpera_order_backfill();
select public.qorpera_schedule_order_upkeep();
