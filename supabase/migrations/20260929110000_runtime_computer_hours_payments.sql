-- Computer hours, build step 4a: payments turn into sources of hours.
-- Contract: section 19, 2026-09-28 amendment "computer hours", items 4, 5, 8 and 9.
-- Design: deploy/first-node/RUNTIME-COMPUTER-HOURS.md ("Payments").
--
-- The computer-billing Edge Function (build step 4b) talks to Stripe. It calls one dispatcher,
-- qorpera_computer_billing(key, method, args), which accepts only a billing key whose SHA-256 an
-- operator enrolled: nodes hold the service role key, and it must not be able to add paid hours.
-- Every writing method takes the billing lock first (qorpera_computer_hour_lock_billing).
--
-- Rules carried out here:
-- * Only a paid invoice or payment adds hours. A plan's first period arrives with its first paid
--   invoice; a renewal's period arrives when the period starts, before its invoice is paid, and is
--   withdrawn (its used part forgiven) if that payment finally fails.
-- * An upgrade adds, once its charge is paid, the new plan's extra hours for the rest of the
--   period in proportion to the time left, as an extra plan period row.
-- * Credits are bought by a founder for the company, last twelve months, and are withdrawn on a
--   refund; a dispute freezes only that purchase, and a won dispute unfreezes it.
-- * Test-mode payments, and any payment before the live switch, only make dry-run sources.
-- Card data never reaches Qorpera: Stripe's checkout page and billing page handle it.

create table public.qorpera_computer_hour_catalog (
	item_key text primary key check (item_key ~ '^[a-z][a-z0-9_]{0,31}$'),
	kind text not null check (kind in ('plan', 'credits')),
	name text not null check (char_length(name) between 1 and 64),
	-- Excluding VAT, in øre.
	price_minor bigint not null check (price_minor > 0),
	currency text not null default 'dkk' check (currency = 'dkk'),
	-- Hours a month for a plan, hours in the pack for credits.
	hours integer not null check (hours > 0),
	-- Stripe price ids, set by an operator per mode; an item without one cannot be bought there.
	stripe_price_test text check (stripe_price_test ~ '^price_[A-Za-z0-9]{1,250}$'),
	stripe_price_live text check (stripe_price_live ~ '^price_[A-Za-z0-9]{1,250}$'),
	active boolean not null default true,
	sort integer not null default 0
);
insert into public.qorpera_computer_hour_catalog (item_key, kind, name, price_minor, hours, sort) values
	('basis', 'plan', 'Basis', 18500, 74, 10),
	('standard', 'plan', 'Standard', 63000, 286, 20),
	('hours_20', 'credits', '20 computer hours', 7000, 20, 30),
	('hours_100', 'credits', '100 computer hours', 35000, 100, 40),
	('hours_500', 'credits', '500 computer hours', 175000, 500, 50);

-- A member's Stripe customer, per mode.
create table public.qorpera_computer_hour_customers (
	user_id uuid not null,
	livemode boolean not null,
	stripe_customer_id text not null unique check (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,250}$'),
	created_at timestamptz not null default clock_timestamp(),
	primary key (user_id, livemode)
);

create table public.qorpera_computer_hour_subscriptions (
	stripe_subscription_id text primary key check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,250}$'),
	user_id uuid not null,
	livemode boolean not null,
	item_key text not null references public.qorpera_computer_hour_catalog(item_key) on delete restrict,
	status text not null check (char_length(status) between 1 and 32),
	period_start timestamptz,
	period_end timestamptz,
	cancel_at_period_end boolean not null default false,
	-- The newest Stripe event applied, so an older event never overwrites a newer state.
	event_created timestamptz not null,
	updated_at timestamptz not null default clock_timestamp()
);
create index qorpera_computer_hour_subscriptions_user on public.qorpera_computer_hour_subscriptions (user_id, livemode);

-- One row per checkout a member starts; its id is the Stripe idempotency key.
create table public.qorpera_computer_hour_checkouts (
	id uuid primary key default extensions.gen_random_uuid(),
	user_id uuid not null,
	item_key text not null references public.qorpera_computer_hour_catalog(item_key) on delete restrict,
	-- The company, for credits.
	profile_id uuid,
	livemode boolean not null,
	stripe_session_id text unique check (stripe_session_id ~ '^cs_[A-Za-z0-9_]{1,250}$'),
	created_at timestamptz not null default clock_timestamp(),
	completed_at timestamptz
);
create index qorpera_computer_hour_checkouts_user on public.qorpera_computer_hour_checkouts (user_id, created_at);

-- Every Stripe event received, once. A replay with the same body is a no-op; another body under
-- the same id is refused.
create table public.qorpera_computer_hour_stripe_events (
	event_id text primary key check (event_id ~ '^evt_[A-Za-z0-9]{1,250}$'),
	type text not null check (char_length(type) between 1 and 128),
	livemode boolean not null,
	body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
	received_at timestamptz not null default clock_timestamp(),
	finished_at timestamptz,
	outcome text check (outcome in ('applied', 'ignored', 'needs_review')),
	detail text check (detail is null or char_length(detail) <= 2000),
	check ((finished_at is null) = (outcome is null))
);

-- Keys the computer-billing Edge Function presents. Only their SHA-256 is stored.
create table public.qorpera_computer_hour_billing_keys (
	key_sha256 text primary key check (key_sha256 ~ '^[0-9a-f]{64}$'),
	created_at timestamptz not null default clock_timestamp(),
	revoked_at timestamptz
);

-- A paid Stripe object adds hours once.
create unique index qorpera_computer_hour_sources_reference on public.qorpera_computer_hour_sources (reference, dry_run)
	where reference is not null;

alter table public.qorpera_computer_hour_catalog enable row level security;
alter table public.qorpera_computer_hour_customers enable row level security;
alter table public.qorpera_computer_hour_subscriptions enable row level security;
alter table public.qorpera_computer_hour_checkouts enable row level security;
alter table public.qorpera_computer_hour_stripe_events enable row level security;
alter table public.qorpera_computer_hour_billing_keys enable row level security;
revoke all on public.qorpera_computer_hour_catalog, public.qorpera_computer_hour_customers,
	public.qorpera_computer_hour_subscriptions, public.qorpera_computer_hour_checkouts,
	public.qorpera_computer_hour_stripe_events, public.qorpera_computer_hour_billing_keys
	from public, anon, authenticated, service_role;
grant select on public.qorpera_computer_hour_catalog, public.qorpera_computer_hour_customers,
	public.qorpera_computer_hour_subscriptions, public.qorpera_computer_hour_checkouts,
	public.qorpera_computer_hour_stripe_events
	to service_role;

create function public.qorpera_computer_billing_timestamp(p_value jsonb, p_label text)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
begin
	if jsonb_typeof(p_value) is distinct from 'string' then
		raise exception 'Billing: % is required', p_label using errcode = '22023';
	end if;
	return (p_value #>> '{}')::timestamptz;
exception when invalid_datetime_format or datetime_field_overflow then
	raise exception 'Billing: % is not a time', p_label using errcode = '22023';
end
$$;
revoke all on function public.qorpera_computer_billing_timestamp(jsonb, text) from public, anon, authenticated, service_role;

-- Sources made from Stripe facts are dry runs in test mode, and before the live switch.
create function public.qorpera_computer_billing_dry_run(p_livemode boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select not coalesce(p_livemode, false) or public.qorpera_computer_hour_dry_run(clock_timestamp())
$$;
revoke all on function public.qorpera_computer_billing_dry_run(boolean) from public, anon, authenticated, service_role;

-- The one door for the computer-billing Edge Function.
create function public.qorpera_computer_billing(p_key text, p_method text, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_livemode boolean := coalesce((p_args ->> 'livemode')::boolean, false);
	v_dry_run boolean;
	v_user uuid;
	v_profile uuid;
	v_item public.qorpera_computer_hour_catalog%rowtype;
	v_from public.qorpera_computer_hour_catalog%rowtype;
	v_price text;
	v_checkout public.qorpera_computer_hour_checkouts%rowtype;
	v_event public.qorpera_computer_hour_stripe_events%rowtype;
	v_subscription public.qorpera_computer_hour_subscriptions%rowtype;
	v_start timestamptz;
	v_end timestamptz;
	v_at timestamptz;
	v_seconds bigint;
	v_reference text;
	v_rows integer;
begin
	if p_key is null or not exists (
		select 1 from public.qorpera_computer_hour_billing_keys billing_key
		where billing_key.key_sha256 = encode(extensions.digest(p_key, 'sha256'), 'hex') and billing_key.revoked_at is null
	) then
		raise exception 'Billing key refused' using errcode = '42501';
	end if;
	if jsonb_typeof(p_args) is distinct from 'object' then
		raise exception 'Billing: arguments must be an object' using errcode = '22023';
	end if;
	v_dry_run := public.qorpera_computer_billing_dry_run(v_livemode);

	if p_method = 'catalog_price' then
		-- The Stripe price of an item in a mode, for re-verifying Stripe's price before checkout.
		select * into v_item from public.qorpera_computer_hour_catalog where item_key = p_args ->> 'itemKey';
		if not found then
			raise exception 'Billing: unknown item' using errcode = '22023';
		end if;
		return jsonb_build_object('itemKey', v_item.item_key, 'kind', v_item.kind, 'priceMinor', v_item.price_minor,
			'currency', v_item.currency, 'hours', v_item.hours, 'active', v_item.active,
			'priceId', case when v_livemode then v_item.stripe_price_live else v_item.stripe_price_test end);
	end if;

	if p_method = 'catalog_item_by_price' then
		-- The catalog item a Stripe price belongs to, in a mode.
		select * into v_item from public.qorpera_computer_hour_catalog
		where (v_livemode and stripe_price_live = p_args ->> 'priceId') or (not v_livemode and stripe_price_test = p_args ->> 'priceId');
		return jsonb_build_object('itemKey', v_item.item_key, 'kind', v_item.kind, 'hours', v_item.hours);
	end if;

	if p_method = 'customer_get' then
		return jsonb_build_object('customerId', (select customer.stripe_customer_id from public.qorpera_computer_hour_customers customer
			where customer.user_id = (p_args ->> 'userId')::uuid and customer.livemode = v_livemode));
	end if;

	if p_method = 'customer_user' then
		return jsonb_build_object('userId', (select customer.user_id from public.qorpera_computer_hour_customers customer
			where customer.stripe_customer_id = p_args ->> 'customerId'));
	end if;

	perform public.qorpera_computer_hour_lock_billing();

	if p_method = 'checkout_begin' then
		v_user := (p_args ->> 'userId')::uuid;
		select * into v_item from public.qorpera_computer_hour_catalog where item_key = p_args ->> 'itemKey' and active;
		v_price := case when v_livemode then v_item.stripe_price_live else v_item.stripe_price_test end;
		if v_item.item_key is null or v_price is null then
			return jsonb_build_object('refused', 'item_unavailable');
		end if;
		if v_item.kind = 'credits' then
			v_profile := (p_args ->> 'profileId')::uuid;
			-- Founders buy credits for their company; nobody else is charged for its machines.
			if v_profile is null or not exists (
				select 1 from public.qorpera_company_founders(v_profile) founder where founder.user_id = v_user
			) then
				return jsonb_build_object('refused', 'not_a_founder');
			end if;
		elsif exists (
			select 1 from public.qorpera_computer_hour_subscriptions subscription
			where subscription.user_id = v_user and subscription.livemode = v_livemode
				and subscription.status not in ('canceled', 'incomplete_expired')
		) then
			-- A member with a plan changes it on Stripe's billing page.
			return jsonb_build_object('refused', 'has_plan');
		end if;
		insert into public.qorpera_computer_hour_checkouts (user_id, item_key, profile_id, livemode)
		values (v_user, v_item.item_key, v_profile, v_livemode)
		returning * into v_checkout;
		return jsonb_build_object('checkoutId', v_checkout.id, 'kind', v_item.kind, 'priceId', v_price,
			'priceMinor', v_item.price_minor, 'hours', v_item.hours,
			'customerId', (select customer.stripe_customer_id from public.qorpera_computer_hour_customers customer
				where customer.user_id = v_user and customer.livemode = v_livemode));

	elsif p_method = 'checkout_attach' then
		update public.qorpera_computer_hour_checkouts set stripe_session_id = p_args ->> 'sessionId'
		where id = (p_args ->> 'checkoutId')::uuid and stripe_session_id is null;
		get diagnostics v_rows = row_count;
		return jsonb_build_object('attached', v_rows = 1);

	elsif p_method = 'customer_set' then
		insert into public.qorpera_computer_hour_customers (user_id, livemode, stripe_customer_id)
		values ((p_args ->> 'userId')::uuid, v_livemode, p_args ->> 'customerId')
		on conflict (user_id, livemode) do nothing;
		return jsonb_build_object('customerId', (select customer.stripe_customer_id from public.qorpera_computer_hour_customers customer
			where customer.user_id = (p_args ->> 'userId')::uuid and customer.livemode = v_livemode));


	elsif p_method = 'event_begin' then
		insert into public.qorpera_computer_hour_stripe_events (event_id, type, livemode, body_sha256)
		values (p_args ->> 'eventId', p_args ->> 'type', v_livemode, p_args ->> 'bodySha256')
		on conflict (event_id) do nothing;
		select * into strict v_event from public.qorpera_computer_hour_stripe_events where event_id = p_args ->> 'eventId';
		if v_event.body_sha256 <> p_args ->> 'bodySha256' then
			raise exception 'Billing: another body under a known event id' using errcode = '42501';
		end if;
		return jsonb_build_object('state', case when v_event.finished_at is null then 'open' else 'finished' end,
			'outcome', v_event.outcome);

	elsif p_method = 'event_finish' then
		update public.qorpera_computer_hour_stripe_events
		set finished_at = clock_timestamp(), outcome = p_args ->> 'outcome', detail = left(p_args ->> 'detail', 2000)
		where event_id = p_args ->> 'eventId' and finished_at is null;
		return jsonb_build_object('finished', true);

	elsif p_method = 'subscription_state' then
		-- The newest state of a subscription wins; an older event changes nothing.
		v_at := public.qorpera_computer_billing_timestamp(p_args -> 'eventCreated', 'event time');
		select * into v_item from public.qorpera_computer_hour_catalog where item_key = p_args ->> 'itemKey' and kind = 'plan';
		if not found then
			return jsonb_build_object('refused', 'unknown_plan');
		end if;
		insert into public.qorpera_computer_hour_subscriptions (stripe_subscription_id, user_id, livemode, item_key, status,
			period_start, period_end, cancel_at_period_end, event_created)
		values (p_args ->> 'subscriptionId', (p_args ->> 'userId')::uuid, v_livemode, v_item.item_key, p_args ->> 'status',
			public.qorpera_computer_billing_timestamp(p_args -> 'periodStart', 'period start'),
			public.qorpera_computer_billing_timestamp(p_args -> 'periodEnd', 'period end'),
			coalesce((p_args ->> 'cancelAtPeriodEnd')::boolean, false), v_at)
		on conflict (stripe_subscription_id) do update set
			item_key = excluded.item_key, status = excluded.status, period_start = excluded.period_start,
			period_end = excluded.period_end, cancel_at_period_end = excluded.cancel_at_period_end,
			event_created = excluded.event_created, updated_at = clock_timestamp()
		where public.qorpera_computer_hour_subscriptions.event_created <= excluded.event_created;
		return jsonb_build_object('applied', true);

	elsif p_method = 'plan_period' then
		-- A plan period's hours: the first period once its invoice is paid, a renewal when it starts.
		select * into v_subscription from public.qorpera_computer_hour_subscriptions
		where stripe_subscription_id = p_args ->> 'subscriptionId';
		select * into v_item from public.qorpera_computer_hour_catalog where item_key = p_args ->> 'itemKey' and kind = 'plan';
		if v_subscription.stripe_subscription_id is null or v_item.item_key is null then
			return jsonb_build_object('refused', 'unknown_subscription_or_plan');
		end if;
		v_start := public.qorpera_computer_billing_timestamp(p_args -> 'periodStart', 'period start');
		v_end := public.qorpera_computer_billing_timestamp(p_args -> 'periodEnd', 'period end');
		if v_end <= v_start then
			return jsonb_build_object('refused', 'empty_period');
		end if;
		v_reference := v_subscription.stripe_subscription_id || ':' || extract(epoch from v_start)::bigint::text;
		insert into public.qorpera_computer_hour_sources (kind, user_id, granted_seconds, period_start, period_end, reference, dry_run)
		values ('plan_period', v_subscription.user_id, v_item.hours::bigint * 3600, v_start, v_end, v_reference, v_dry_run)
		on conflict do nothing;
		get diagnostics v_rows = row_count;
		return jsonb_build_object('added', v_rows = 1, 'reference', v_reference);

	elsif p_method = 'plan_upgrade' then
		-- Paid upgrade: the new plan's extra hours for the rest of the period, pro rata.
		select * into v_subscription from public.qorpera_computer_hour_subscriptions
		where stripe_subscription_id = p_args ->> 'subscriptionId';
		select * into v_from from public.qorpera_computer_hour_catalog where item_key = p_args ->> 'fromItemKey' and kind = 'plan';
		select * into v_item from public.qorpera_computer_hour_catalog where item_key = p_args ->> 'toItemKey' and kind = 'plan';
		if v_subscription.stripe_subscription_id is null or v_from.item_key is null or v_item.item_key is null then
			return jsonb_build_object('refused', 'unknown_subscription_or_plan');
		end if;
		v_start := public.qorpera_computer_billing_timestamp(p_args -> 'periodStart', 'period start');
		v_end := public.qorpera_computer_billing_timestamp(p_args -> 'periodEnd', 'period end');
		v_at := greatest(v_start, least(v_end, public.qorpera_computer_billing_timestamp(p_args -> 'paidAt', 'paid at')));
		v_seconds := floor((v_item.hours - v_from.hours)::numeric * 3600
			* extract(epoch from (v_end - v_at)) / nullif(extract(epoch from (v_end - v_start)), 0))::bigint;
		if coalesce(v_seconds, 0) <= 0 then
			return jsonb_build_object('added', false, 'seconds', 0);
		end if;
		v_reference := p_args ->> 'invoiceId';
		insert into public.qorpera_computer_hour_sources (kind, user_id, granted_seconds, period_start, period_end, reference, dry_run)
		values ('plan_period', v_subscription.user_id, v_seconds, v_at, v_end, v_reference, v_dry_run)
		on conflict do nothing;
		get diagnostics v_rows = row_count;
		return jsonb_build_object('added', v_rows = 1, 'seconds', v_seconds);

	elsif p_method = 'plan_failed' then
		-- The period's payment finally failed: its unused hours are withdrawn, its used hours forgiven.
		v_start := public.qorpera_computer_billing_timestamp(p_args -> 'periodStart', 'period start');
		update public.qorpera_computer_hour_sources set withdrawn_at = clock_timestamp()
		where reference = (p_args ->> 'subscriptionId') || ':' || extract(epoch from v_start)::bigint::text
			and dry_run = v_dry_run and withdrawn_at is null;
		get diagnostics v_rows = row_count;
		return jsonb_build_object('withdrawn', v_rows);

	elsif p_method = 'credits_paid' then
		select * into v_checkout from public.qorpera_computer_hour_checkouts where stripe_session_id = p_args ->> 'sessionId';
		select * into v_item from public.qorpera_computer_hour_catalog where item_key = v_checkout.item_key and kind = 'credits';
		if v_checkout.id is null or v_item.item_key is null or v_checkout.profile_id is null then
			return jsonb_build_object('refused', 'unknown_checkout');
		end if;
		v_at := public.qorpera_computer_billing_timestamp(p_args -> 'paidAt', 'paid at');
		insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, granted_seconds, expires_at, reference, dry_run)
		values ('credit', v_checkout.profile_id, v_checkout.user_id, v_item.hours::bigint * 3600,
			v_at + interval '12 months', p_args ->> 'paymentIntentId', v_dry_run)
		on conflict do nothing;
		get diagnostics v_rows = row_count;
		update public.qorpera_computer_hour_checkouts set completed_at = coalesce(completed_at, clock_timestamp())
		where id = v_checkout.id;
		return jsonb_build_object('added', v_rows = 1, 'profileId', v_checkout.profile_id, 'userId', v_checkout.user_id);

	elsif p_method = 'refund' then
		-- A refund takes back the unused hours of its purchase.
		update public.qorpera_computer_hour_sources set withdrawn_at = clock_timestamp()
		where kind = 'credit' and reference = p_args ->> 'paymentIntentId' and dry_run = v_dry_run and withdrawn_at is null;
		get diagnostics v_rows = row_count;
		return jsonb_build_object('withdrawn', v_rows);

	elsif p_method = 'dispute' then
		-- A dispute freezes only its purchase; won, it is unfrozen; lost, its unused hours are withdrawn.
		if p_args ->> 'status' = 'open' then
			update public.qorpera_computer_hour_sources set frozen_at = coalesce(frozen_at, clock_timestamp())
			where kind = 'credit' and reference = p_args ->> 'paymentIntentId' and dry_run = v_dry_run;
		elsif p_args ->> 'status' = 'won' then
			update public.qorpera_computer_hour_sources set frozen_at = null
			where kind = 'credit' and reference = p_args ->> 'paymentIntentId' and dry_run = v_dry_run and frozen_at is not null;
		elsif p_args ->> 'status' = 'lost' then
			update public.qorpera_computer_hour_sources set withdrawn_at = coalesce(withdrawn_at, clock_timestamp())
			where kind = 'credit' and reference = p_args ->> 'paymentIntentId' and dry_run = v_dry_run;
		else
			raise exception 'Billing: unknown dispute status' using errcode = '22023';
		end if;
		get diagnostics v_rows = row_count;
		return jsonb_build_object('changed', v_rows);
	end if;
	raise exception 'Billing: unknown method %', p_method using errcode = '22023';
end
$$;
revoke all on function public.qorpera_computer_billing(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_computer_billing(text, text, jsonb) to service_role;

-- What a member can buy: the plans and credit packs on sale, excluding VAT.
create function public.qorpera_list_computer_hour_offers()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object('schema', 'qorpera.computer-hour-offers/v1', 'items', coalesce(jsonb_agg(jsonb_build_object(
		'itemKey', item.item_key, 'kind', item.kind, 'name', item.name, 'priceMinor', item.price_minor,
		'currency', item.currency, 'hours', item.hours
	) order by item.sort, item.item_key), '[]'::jsonb))
	from public.qorpera_computer_hour_catalog item
	where item.active and auth.uid() is not null
$$;
revoke all on function public.qorpera_list_computer_hour_offers() from public, anon;
grant execute on function public.qorpera_list_computer_hour_offers() to authenticated;

-- The signed-in member's own plan: their subscription, and this period's hours by company.
create function public.qorpera_read_my_computer_plan()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_user uuid := auth.uid();
	v_now timestamptz := clock_timestamp();
	v_dry_run boolean := public.qorpera_computer_hour_dry_run(clock_timestamp());
	v_subscription public.qorpera_computer_hour_subscriptions%rowtype;
begin
	if v_user is null then
		raise exception 'Sign in to read your plan' using errcode = '42501';
	end if;
	select * into v_subscription from public.qorpera_computer_hour_subscriptions subscription
	where subscription.user_id = v_user and subscription.livemode = not v_dry_run
		and subscription.status not in ('canceled', 'incomplete_expired')
	order by subscription.updated_at desc
	limit 1;
	return jsonb_build_object(
		'schema', 'qorpera.my-computer-plan/v1',
		'mode', case when v_dry_run then 'dry_run' else 'live' end,
		'plan', case when v_subscription.stripe_subscription_id is null then null else jsonb_build_object(
			'itemKey', v_subscription.item_key, 'status', v_subscription.status,
			'periodStart', v_subscription.period_start, 'periodEnd', v_subscription.period_end,
			'cancelAtPeriodEnd', v_subscription.cancel_at_period_end) end,
		'grantedSeconds', coalesce((select sum(plan.granted_seconds) from public.qorpera_computer_hour_sources plan
			where plan.kind = 'plan_period' and plan.user_id = v_user and plan.dry_run = v_dry_run and plan.withdrawn_at is null
				and plan.period_start <= v_now and v_now < plan.period_end), 0),
		'companies', coalesce((
			select jsonb_agg(jsonb_build_object('profileId', used.profile_id, 'seconds', used.seconds) order by used.seconds desc)
			from (
				select paid.profile_id, sum(paid.seconds)::bigint as seconds
				from (
					select usage.profile_id, draw.standard_seconds as seconds
					from public.qorpera_computer_hour_sources plan
					join public.qorpera_computer_hour_draws draw on draw.source_id = plan.id
					join public.qorpera_computer_hour_usage usage on usage.id = draw.usage_id
					where plan.kind = 'plan_period' and plan.user_id = v_user and plan.dry_run = v_dry_run
						and plan.period_start <= v_now and v_now < plan.period_end
					union all
					select owed.profile_id, repayment.standard_seconds
					from public.qorpera_computer_hour_sources plan
					join public.qorpera_computer_hour_repayments repayment on repayment.source_id = plan.id
					join public.qorpera_computer_hour_sources owed on owed.id = repayment.owed_source_id
					where plan.kind = 'plan_period' and plan.user_id = v_user and plan.dry_run = v_dry_run
						and plan.period_start <= v_now and v_now < plan.period_end
				) paid
				group by paid.profile_id
			) used
		), '[]'::jsonb)
	);
end
$$;
revoke all on function public.qorpera_read_my_computer_plan() from public, anon;
grant execute on function public.qorpera_read_my_computer_plan() to authenticated;
