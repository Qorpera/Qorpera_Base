-- Good will (Jonas, 5 Nov 2026; design note good-will-tax-design.md): a company pays Qorpera a share of what its
-- customers pay it, and nothing else is billed. Each month's sales without moms pay falling steps, each krone the rate
-- of its own step (like tax brackets): 10 % of the first 100,000 kr, 5 % to 250,000, 2 % to 500,000, 1 % to 1 million
-- and 0.2 % above. The steps start over each month; under 100 kr rolls over to the next month; no sales is 0 kr and
-- nothing is switched off.
--
-- - qorpera_good_will_step_versions / _steps: the steps, versioned by the month they apply from.
-- - qorpera_good_will_items: one row per incoming payment a company's connections show (the bank's booked
--   transactions with amount > 0; Stripe and shop connections join when they exist), counted or not, with the reason
--   and who decided: the finance agent (the Co-Founder until one is hired), a member, or a rule.
-- - qorpera_good_will_months: one row per company per month: what counted, the fee per step, what rolled over, and
--   where the charge stands.
-- - qorpera_good_will_payers: the card that pays a company's good will (an owner's, saved through Stripe's own page).
--
-- A month is open while it runs. On the 1st it is sorting: the finance agent sorts its payments and shows the members
-- what counted; anyone may change one, and the agent never changes what a member decided. On the 5th, and at least four
-- days after it began sorting (a bank connected late gives the agent those days too), it is final: a payment nobody
-- sorted counts as a sale, and the month is closed (to charge), carried (under 100 kr, added to the next month) or zero. The computer-billing Edge Function
-- charges a closed month through Stripe (25 % moms on the invoice, or reverse charge), only through the billing door
-- below and only as Stripe test mode until the live switch (qorpera_computer_hour_dry_run). A month's payments booked
-- after it is final count in the next month that is not.
--
-- Members read their company's good will; the account page reads each of the member's companies. Only the functions
-- here reach the tables; they go with the company when it is deleted.

-- 1. The steps ----------------------------------------------------------------------------------------------------------

create table public.qorpera_good_will_step_versions (
	valid_from date primary key check (valid_from = date_trunc('month', valid_from)::date),
	-- A month's bill under this charges nothing and rolls over (10,000 øre = 100 kr).
	min_charge_ore bigint not null check (min_charge_ore >= 0),
	created_at timestamptz not null default clock_timestamp()
);
create table public.qorpera_good_will_steps (
	valid_from date not null references public.qorpera_good_will_step_versions(valid_from) on delete cascade,
	-- The month's sales without moms from which this rate applies, in øre.
	lower_ore bigint not null check (lower_ore >= 0),
	rate_bp integer not null check (rate_bp between 0 and 10000),
	primary key (valid_from, lower_ore)
);
alter table public.qorpera_good_will_step_versions enable row level security;
alter table public.qorpera_good_will_steps enable row level security;
revoke all on public.qorpera_good_will_step_versions, public.qorpera_good_will_steps
	from public, anon, authenticated, service_role;

insert into public.qorpera_good_will_step_versions (valid_from, min_charge_ore) values ('2026-11-01', 10000);
insert into public.qorpera_good_will_steps (valid_from, lower_ore, rate_bp) values
	('2026-11-01', 0, 1000),
	('2026-11-01', 10000000, 500),
	('2026-11-01', 25000000, 200),
	('2026-11-01', 50000000, 100),
	('2026-11-01', 100000000, 20);

-- The fee on a month's sales without moms, under the steps that apply to that month: each step's part of the sales
-- times its rate, rounded to whole øre per step.
create function public.qorpera_good_will_fee(p_net_ore bigint, p_month date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	with version as (
		select v.valid_from, v.min_charge_ore from public.qorpera_good_will_step_versions as v
		where v.valid_from <= coalesce(p_month, current_date) order by v.valid_from desc limit 1
	), steps as (
		select s.lower_ore, lead(s.lower_ore) over (order by s.lower_ore) as upper_ore, s.rate_bp
		from public.qorpera_good_will_steps as s join version on version.valid_from = s.valid_from
	), parts as (
		select lower_ore, upper_ore, rate_bp,
			greatest(0, least(greatest(coalesce(p_net_ore, 0), 0), coalesce(upper_ore, greatest(coalesce(p_net_ore, 0), 0))) - lower_ore)
				as base_ore
		from steps
	)
	select jsonb_build_object(
		'validFrom', (select valid_from from version),
		'minChargeOre', (select min_charge_ore from version),
		'feeOre', coalesce(sum(round(parts.base_ore * parts.rate_bp / 10000.0)::bigint), 0),
		'steps', coalesce(jsonb_agg(jsonb_build_object('fromOre', parts.lower_ore, 'toOre', parts.upper_ore,
			'rateBp', parts.rate_bp, 'baseOre', parts.base_ore,
			'feeOre', round(parts.base_ore * parts.rate_bp / 10000.0)::bigint) order by parts.lower_ore), '[]'::jsonb))
	from parts
$$;
revoke all on function public.qorpera_good_will_fee(bigint, date) from public, anon, authenticated, service_role;

-- 2. Payments, months, the card -----------------------------------------------------------------------------------------

create table public.qorpera_good_will_items (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	-- The month the payment counts in: its booking month, or the first month not final yet.
	month date not null check (month = date_trunc('month', month)::date),
	source text not null check (source in ('bank', 'stripe')),
	-- bank: the account key and the transaction key the vault keeps (qorpera_bank_transactions).
	source_key text not null check (char_length(source_key) between 1 and 200),
	booked_on date not null,
	amount_ore bigint not null check (amount_ore > 0),
	currency text not null check (currency ~ '^[A-Z]{3}$'),
	counterparty text check (counterparty is null or char_length(counterparty) between 1 and 140),
	remittance text check (remittance is null or char_length(remittance) between 1 and 280),
	-- Null until sorted. Only kroner count for now.
	counted boolean check (counted is not true or currency = 'DKK'),
	-- The moms inside a counted payment: a Danish sale's 25 % (a fifth of the amount) unless whoever sorts it says
	-- otherwise (0 for a sale abroad).
	moms_ore bigint not null default 0 check (moms_ore >= 0 and moms_ore <= amount_ore),
	reason text check (reason in ('sale', 'member_money', 'own_transfer', 'refund', 'moms_back', 'loan_or_grant', 'other')),
	note text check (note is null or char_length(note) between 1 and 200),
	decided_by text check (decided_by in ('agent', 'member', 'rule')),
	decided_by_staff_id uuid,
	decided_by_user_id uuid,
	decided_at timestamptz,
	first_seen_at timestamptz not null default clock_timestamp(),
	unique (profile_id, source, source_key),
	check ((counted is null) = (decided_by is null) and (counted is null) = (reason is null)
		and (counted is null) = (decided_at is null)),
	check (counted is null or counted = (reason = 'sale')),
	check ((decided_by = 'agent') = (decided_by_staff_id is not null)),
	check ((decided_by = 'member') = (decided_by_user_id is not null)),
	check (counted is true or moms_ore = 0)
);
create index qorpera_good_will_items_month on public.qorpera_good_will_items (profile_id, month, booked_on);

create table public.qorpera_good_will_months (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	month date not null check (month = date_trunc('month', month)::date),
	-- open: the month runs; sorting: it ended and its payments are sorted (until the 5th); closed: final, to charge;
	-- carried: final, under the least charge, added to the next month; zero: final, nothing to pay; charged: paid;
	-- failed: Stripe could not take the card (it tries again; we post a reminder in chat).
	status text not null default 'open'
		check (status in ('open', 'sorting', 'closed', 'carried', 'zero', 'charged', 'failed')),
	-- What counted: the payments with moms, the moms in them, the sales without moms the steps apply to.
	sales_ore bigint not null default 0 check (sales_ore >= 0),
	moms_ore bigint not null default 0 check (moms_ore >= 0 and moms_ore <= sales_ore),
	net_ore bigint not null default 0 check (net_ore >= 0),
	fee_ore bigint not null default 0 check (fee_ore >= 0),
	-- The fee per step (qorpera_good_will_fee's answer).
	fee jsonb not null default '{}'::jsonb check (jsonb_typeof(fee) = 'object'),
	carried_in_ore bigint not null default 0 check (carried_in_ore >= 0),
	-- fee + carried in, without the invoice's moms.
	due_ore bigint not null default 0 check (due_ore >= 0),
	carried_out_ore bigint not null default 0 check (carried_out_ore >= 0),
	-- How many payments wait to be sorted.
	unsorted integer not null default 0 check (unsorted >= 0),
	-- The day (Danish time) the month began sorting: it is final no sooner than four days later.
	sorting_since date,
	payer_user_id uuid,
	stripe_invoice_id text check (stripe_invoice_id is null or stripe_invoice_id ~ '^in_[A-Za-z0-9]{1,250}$'),
	invoice_url text check (invoice_url is null or (invoice_url ~ '^https://' and char_length(invoice_url) <= 2000)),
	livemode boolean,
	final_at timestamptz,
	charged_at timestamptz,
	updated_at timestamptz not null default clock_timestamp(),
	primary key (profile_id, month),
	check (net_ore = sales_ore - moms_ore and due_ore = fee_ore + carried_in_ore),
	check ((status in ('open', 'sorting')) = (final_at is null)),
	check ((status = 'open') = (sorting_since is null)),
	check ((status = 'carried') = (carried_out_ore > 0)),
	check (status <> 'zero' or due_ore = 0),
	check ((status = 'charged') = (charged_at is not null)),
	check (status not in ('charged', 'failed') or stripe_invoice_id is not null)
);
create index qorpera_good_will_months_due on public.qorpera_good_will_months (status, month)
	where status in ('sorting', 'closed', 'failed');
create unique index qorpera_good_will_months_invoice on public.qorpera_good_will_months (stripe_invoice_id)
	where stripe_invoice_id is not null;

create table public.qorpera_good_will_payers (
	profile_id uuid primary key references public.qorpera_profiles(id) on delete cascade,
	user_id uuid not null,
	livemode boolean not null,
	stripe_customer_id text not null check (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,250}$'),
	payment_method_id text not null check (payment_method_id ~ '^pm_[A-Za-z0-9]{1,250}$'),
	brand text check (brand is null or brand ~ '^[a-z_]{1,32}$'),
	last4 text check (last4 is null or last4 ~ '^[0-9]{4}$'),
	saved_at timestamptz not null default clock_timestamp()
);

-- One row per card page an owner opens (Stripe Checkout in setup mode); its id is Stripe's idempotency key.
create table public.qorpera_good_will_card_setups (
	id uuid primary key default extensions.gen_random_uuid(),
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	user_id uuid not null,
	livemode boolean not null,
	stripe_session_id text unique check (stripe_session_id ~ '^cs_[A-Za-z0-9_]{1,250}$'),
	created_at timestamptz not null default clock_timestamp(),
	completed_at timestamptz
);

-- The company's own Stripe customer per mode (its name and address on the invoice, so Stripe Tax uses the company's),
-- never a member's.
create table public.qorpera_good_will_customers (
	profile_id uuid not null references public.qorpera_profiles(id) on delete cascade,
	livemode boolean not null,
	stripe_customer_id text not null unique check (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,250}$'),
	created_at timestamptz not null default clock_timestamp(),
	primary key (profile_id, livemode)
);
create index qorpera_good_will_card_setups_profile on public.qorpera_good_will_card_setups (profile_id, created_at);

alter table public.qorpera_good_will_items enable row level security;
alter table public.qorpera_good_will_months enable row level security;
alter table public.qorpera_good_will_payers enable row level security;
alter table public.qorpera_good_will_card_setups enable row level security;
alter table public.qorpera_good_will_customers enable row level security;
revoke all on public.qorpera_good_will_items, public.qorpera_good_will_months, public.qorpera_good_will_payers,
	public.qorpera_good_will_card_setups, public.qorpera_good_will_customers from public, anon, authenticated, service_role;

-- 3. Months -------------------------------------------------------------------------------------------------------------

-- Months turn in Danish time.
create function public.qorpera_good_will_today()
returns date
language sql
stable
security definer
set search_path = ''
as $$
	select (clock_timestamp() at time zone 'Europe/Copenhagen')::date
$$;
revoke all on function public.qorpera_good_will_today() from public, anon, authenticated, service_role;

-- The first month good will applies to the company: the steps' first month, or the month it was made.
create function public.qorpera_good_will_first_month(p_profile_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
	select greatest((select min(v.valid_from) from public.qorpera_good_will_step_versions as v),
		(select date_trunc('month', p.created_at at time zone 'Europe/Copenhagen')::date
			from public.qorpera_profiles as p where p.id = p_profile_id))
$$;
revoke all on function public.qorpera_good_will_first_month(uuid) from public, anon, authenticated, service_role;

-- The month's row on a day (Danish time), locked, made when missing: open while it runs, sorting once it ended. Null for
-- a month before the company's first.
create function public.qorpera_good_will_month_row(p_profile_id uuid, p_month date, p_today date)
returns public.qorpera_good_will_months
language plpgsql
security definer
set search_path = ''
as $$
declare v_row public.qorpera_good_will_months%rowtype;
	v_month date := date_trunc('month', p_month)::date;
begin
	if v_month < public.qorpera_good_will_first_month(p_profile_id) then return null; end if;
	insert into public.qorpera_good_will_months (profile_id, month, status, sorting_since)
	select p_profile_id, v_month, case when ended then 'sorting' else 'open' end, case when ended then p_today end
	from (select v_month < date_trunc('month', p_today)::date as ended) as month_state
	on conflict (profile_id, month) do nothing;
	select * into v_row from public.qorpera_good_will_months as m
	where m.profile_id = p_profile_id and m.month = v_month for update;
	if v_row.status = 'open' and v_month < date_trunc('month', p_today)::date then
		update public.qorpera_good_will_months as m
		set status = 'sorting', sorting_since = p_today, updated_at = clock_timestamp()
		where m.profile_id = p_profile_id and m.month = v_month
		returning * into v_row;
	end if;
	return v_row;
end
$$;
revoke all on function public.qorpera_good_will_month_row(uuid, date, date) from public, anon, authenticated, service_role;

-- A month's totals again from its payments, while it is not final: what counted, the fee, and what the month before
-- rolled over.
create function public.qorpera_good_will_recompute(p_profile_id uuid, p_month date, p_today date)
returns public.qorpera_good_will_months
language plpgsql
security definer
set search_path = ''
as $$
declare v_row public.qorpera_good_will_months%rowtype; v_sales bigint; v_moms bigint; v_unsorted integer;
	v_fee jsonb; v_in bigint;
begin
	v_row := public.qorpera_good_will_month_row(p_profile_id, p_month, p_today);
	if v_row.profile_id is null or v_row.status not in ('open', 'sorting') then return v_row; end if;
	select coalesce(sum(i.amount_ore) filter (where i.counted), 0), coalesce(sum(i.moms_ore) filter (where i.counted), 0),
		count(*) filter (where i.counted is null)
	into v_sales, v_moms, v_unsorted
	from public.qorpera_good_will_items as i where i.profile_id = p_profile_id and i.month = v_row.month;
	v_fee := public.qorpera_good_will_fee(v_sales - v_moms, v_row.month);
	select coalesce(sum(m.carried_out_ore), 0) into v_in from public.qorpera_good_will_months as m
	where m.profile_id = p_profile_id and m.month = (v_row.month - interval '1 month')::date and m.status = 'carried';
	update public.qorpera_good_will_months as m
	set sales_ore = v_sales, moms_ore = v_moms, net_ore = v_sales - v_moms, fee_ore = (v_fee ->> 'feeOre')::bigint,
		fee = v_fee, carried_in_ore = v_in, due_ore = (v_fee ->> 'feeOre')::bigint + v_in, unsorted = v_unsorted,
		updated_at = clock_timestamp()
	where m.profile_id = p_profile_id and m.month = v_row.month
	returning * into v_row;
	return v_row;
end
$$;
revoke all on function public.qorpera_good_will_recompute(uuid, date, date) from public, anon, authenticated, service_role;

-- The company's bank payments in (amount > 0) booked in the last two months, each kept once in the month it counts in.
-- A payment the same day ±3 that left another of the company's accounts for the same amount is a move between its own
-- accounts: not counted, by rule. Then every month not final yet, and this one, is recomputed. Answers how many payments
-- were new.
create function public.qorpera_good_will_gather(p_profile_id uuid, p_today date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_today date := p_today; v_since date; v_floor date; v_month date; v_kept integer;
begin
	-- One gather or close of a company at a time, so a payment never lands in a month that turns final meanwhile.
	perform pg_advisory_xact_lock(hashtextextended('qorpera.good-will:' || p_profile_id::text, 0));
	v_since := greatest(public.qorpera_good_will_first_month(p_profile_id),
		(date_trunc('month', v_today) - interval '2 months')::date);
	-- Payments of a final month count in the first month after the newest final one.
	select (max(m.month) + interval '1 month')::date into v_floor from public.qorpera_good_will_months as m
	where m.profile_id = p_profile_id and m.status not in ('open', 'sorting');
	insert into public.qorpera_good_will_items as item (profile_id, month, source, source_key, booked_on, amount_ore, currency,
		counterparty, remittance, counted, reason, decided_by, decided_at)
	select t.profile_id, greatest(date_trunc('month', t.booked_on)::date, coalesce(v_floor, '-infinity'::date)), 'bank',
		t.account_key || ':' || t.transaction_key, t.booked_on, (t.amount * 100)::bigint, t.currency, t.counterparty,
		t.remittance, case when own.moved then false end, case when own.moved then 'own_transfer' end,
		case when own.moved then 'rule' end, case when own.moved then clock_timestamp() end
	from public.qorpera_bank_transactions as t
	cross join lateral (select exists (select 1 from public.qorpera_bank_transactions as leg
		where leg.profile_id = t.profile_id and leg.account_key <> t.account_key and leg.amount = -t.amount
			and leg.booked_on between t.booked_on - 3 and t.booked_on + 3) as moved) as own
	where t.profile_id = p_profile_id and t.amount > 0 and t.booked_on >= v_since and t.booked_on <= v_today
	on conflict (profile_id, source, source_key) do nothing;
	get diagnostics v_kept = row_count;
	-- The other account's leg can arrive with a later fetch: an unsorted payment of a month not final is checked again.
	update public.qorpera_good_will_items as i
	set counted = false, reason = 'own_transfer', decided_by = 'rule', decided_at = clock_timestamp()
	from public.qorpera_good_will_months as m
	where i.profile_id = p_profile_id and i.counted is null and i.source = 'bank' and m.profile_id = i.profile_id
		and m.month = i.month and m.status in ('open', 'sorting')
		and exists (select 1 from public.qorpera_bank_transactions as t
			join public.qorpera_bank_transactions as leg on leg.profile_id = t.profile_id and leg.account_key <> t.account_key
				and leg.amount = -t.amount and leg.booked_on between t.booked_on - 3 and t.booked_on + 3
			where t.profile_id = i.profile_id and t.account_key || ':' || t.transaction_key = i.source_key);
	for v_month in
		select distinct i.month from public.qorpera_good_will_items as i
		where i.profile_id = p_profile_id and i.month >= v_since
		union select m.month from public.qorpera_good_will_months as m
		where m.profile_id = p_profile_id and m.status in ('open', 'sorting')
		union select date_trunc('month', v_today)::date
		order by 1
	loop
		perform public.qorpera_good_will_recompute(p_profile_id, v_month, v_today);
	end loop;
	return v_kept;
end
$$;
revoke all on function public.qorpera_good_will_gather(uuid, date) from public, anon, authenticated, service_role;

-- The month's last word (on the 5th, after four days of sorting): a payment nobody sorted counts as a sale (with a
-- Danish sale's moms), then the month is closed, carried or zero.
create function public.qorpera_good_will_finalize(p_profile_id uuid, p_month date, p_today date)
returns public.qorpera_good_will_months
language plpgsql
security definer
set search_path = ''
as $$
declare v_row public.qorpera_good_will_months%rowtype; v_min bigint;
begin
	perform pg_advisory_xact_lock(hashtextextended('qorpera.good-will:' || p_profile_id::text, 0));
	v_row := public.qorpera_good_will_month_row(p_profile_id, p_month, p_today);
	if v_row.profile_id is null or v_row.status <> 'sorting' then return v_row; end if;
	-- Four days to sort, also for a month that began sorting late (a bank connected after the 1st).
	if p_today < v_row.sorting_since + 4 then return v_row; end if;
	update public.qorpera_good_will_items as i
	set counted = (i.currency = 'DKK'), reason = case when i.currency = 'DKK' then 'sale' else 'other' end,
		moms_ore = case when i.currency = 'DKK' then round(i.amount_ore / 5.0)::bigint else 0 end,
		note = case when i.currency = 'DKK' then 'Not sorted by the 5th: counted as a sale.'
			else 'Not sorted by the 5th: only kroner count for now.' end,
		decided_by = 'rule', decided_at = clock_timestamp()
	where i.profile_id = p_profile_id and i.month = v_row.month and i.counted is null;
	v_row := public.qorpera_good_will_recompute(p_profile_id, v_row.month, p_today);
	v_min := coalesce((v_row.fee ->> 'minChargeOre')::bigint, 10000);
	update public.qorpera_good_will_months as m
	set status = case when m.due_ore = 0 then 'zero' when m.due_ore < v_min then 'carried' else 'closed' end,
		carried_out_ore = case when m.due_ore > 0 and m.due_ore < v_min then m.due_ore else 0 end,
		payer_user_id = (select p.user_id from public.qorpera_good_will_payers as p where p.profile_id = m.profile_id),
		final_at = clock_timestamp(), updated_at = clock_timestamp()
	where m.profile_id = p_profile_id and m.month = v_row.month
	returning * into v_row;
	return v_row;
end
$$;
revoke all on function public.qorpera_good_will_finalize(uuid, date, date) from public, anon, authenticated, service_role;

-- One payment sorted: 'sale' counts it (with the moms inside it: a fifth of the amount unless given), any other reason
-- does not. Only payments of a month that is not final, and only kroner, count. Answers the payment and its month.
create function public.qorpera_good_will_decide(
	p_profile_id uuid,
	p_item_id uuid,
	p_reason text,
	p_moms_ore bigint,
	p_note text,
	p_by text,
	p_staff_id uuid,
	p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_item public.qorpera_good_will_items%rowtype; v_month public.qorpera_good_will_months%rowtype;
begin
	if p_reason is null or p_reason not in ('sale', 'member_money', 'own_transfer', 'refund', 'moms_back', 'loan_or_grant', 'other') then
		raise exception 'Good will: the reason is not one of sale, member_money, own_transfer, refund, moms_back, loan_or_grant, other'
			using errcode = '22023'; end if;
	if p_note is not null and char_length(btrim(p_note)) not between 1 and 200 then
		raise exception 'Good will: a note is 1 to 200 characters' using errcode = '22023'; end if;
	select * into v_item from public.qorpera_good_will_items as i where i.id = p_item_id and i.profile_id = p_profile_id;
	if v_item.id is null then
		raise exception 'Good will: no payment % in this company', p_item_id using errcode = '22023'; end if;
	-- The month first, then the payment: the order the close takes.
	v_month := public.qorpera_good_will_month_row(p_profile_id, v_item.month, public.qorpera_good_will_today());
	if v_month.status not in ('open', 'sorting') then
		raise exception 'Good will: % is final; its payments can no longer change', to_char(v_item.month, 'YYYY-MM')
			using errcode = '55000'; end if;
	select * into v_item from public.qorpera_good_will_items as i where i.id = p_item_id for update;
	-- A member's decision stands: an agent never changes it (a member may).
	if p_by = 'agent' and v_item.decided_by = 'member' then
		raise exception 'Good will: a member sorted payment %; leave it as they decided', p_item_id using errcode = '55000'; end if;
	if p_reason = 'sale' and v_item.currency <> 'DKK' then
		raise exception 'Good will: payment % is in %; only payments in kroner count for now', p_item_id, v_item.currency
			using errcode = '22023'; end if;
	if p_reason = 'sale' and p_moms_ore is not null and p_moms_ore not between 0 and v_item.amount_ore then
		raise exception 'Good will: the moms of payment % is between 0 and its amount', p_item_id using errcode = '22023'; end if;
	update public.qorpera_good_will_items as i
	set counted = (p_reason = 'sale'), reason = p_reason,
		moms_ore = case when p_reason = 'sale' then coalesce(p_moms_ore, round(i.amount_ore / 5.0)::bigint) else 0 end,
		note = nullif(btrim(p_note), ''), decided_by = p_by, decided_by_staff_id = p_staff_id, decided_by_user_id = p_user_id,
		decided_at = clock_timestamp()
	where i.id = p_item_id
	returning * into v_item;
	v_month := public.qorpera_good_will_recompute(p_profile_id, v_item.month, public.qorpera_good_will_today());
	return jsonb_build_object('item', public.qorpera_good_will_item_json(v_item),
		'month', public.qorpera_good_will_month_json(v_month));
end
$$;
revoke all on function public.qorpera_good_will_decide(uuid, uuid, text, bigint, text, text, uuid, uuid)
	from public, anon, authenticated, service_role;

create function public.qorpera_good_will_item_json(p_item public.qorpera_good_will_items)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object('id', p_item.id, 'month', to_char(p_item.month, 'YYYY-MM'), 'source', p_item.source,
		'bookedOn', p_item.booked_on, 'amountOre', p_item.amount_ore, 'currency', p_item.currency,
		'counterparty', p_item.counterparty, 'text', p_item.remittance, 'counted', p_item.counted, 'reason', p_item.reason,
		'momsOre', p_item.moms_ore, 'note', p_item.note, 'decidedBy', p_item.decided_by, 'decidedAt', p_item.decided_at)
$$;
revoke all on function public.qorpera_good_will_item_json(public.qorpera_good_will_items)
	from public, anon, authenticated, service_role;

create function public.qorpera_good_will_month_json(p_month public.qorpera_good_will_months)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object('month', to_char(p_month.month, 'YYYY-MM'), 'status', p_month.status,
		'salesOre', p_month.sales_ore, 'momsOre', p_month.moms_ore, 'netOre', p_month.net_ore, 'feeOre', p_month.fee_ore,
		'steps', coalesce(p_month.fee -> 'steps', '[]'::jsonb), 'carriedInOre', p_month.carried_in_ore,
		'dueOre', p_month.due_ore, 'carriedOutOre', p_month.carried_out_ore, 'unsorted', p_month.unsorted,
		'finalAt', p_month.final_at, 'chargedAt', p_month.charged_at, 'invoiceUrl', p_month.invoice_url)
$$;
revoke all on function public.qorpera_good_will_month_json(public.qorpera_good_will_months)
	from public, anon, authenticated, service_role;

-- 4. The finance agent's calls ------------------------------------------------------------------------------------------

-- The run that sorts: a company agent's (never a worker's), whose wake allows work.
create function public.qorpera_good_will_agent_run(p_binding jsonb)
returns public.qorpera_execution_runs
language plpgsql
security definer
set search_path = ''
as $$
declare v_run public.qorpera_execution_runs%rowtype;
begin
	v_run := public.qorpera_native_tool_locked_run(p_binding);
	perform public.qorpera_assert_wake_work_allowed(v_run.id);
	if v_run.staff_agent_id is null or (public.qorpera_run_worker(v_run.id)).id is not null then
		raise exception 'Only a company agent sorts the company''s payments' using errcode = '42501'; end if;
	return v_run;
end
$$;
revoke all on function public.qorpera_good_will_agent_run(jsonb) from public, anon, authenticated, service_role;

-- A month's payments in ('YYYY-MM'; none: last month), gathered from the bank first, with what counted so far.
create function public.qorpera_good_will_agent_list(p_binding jsonb, p_month text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_run public.qorpera_execution_runs%rowtype; v_month date; v_row public.qorpera_good_will_months%rowtype;
	v_items jsonb; v_total integer;
begin
	v_run := public.qorpera_good_will_agent_run(p_binding);
	if p_month is null then
		v_month := (date_trunc('month', public.qorpera_good_will_today()) - interval '1 month')::date;
	elsif p_month !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$' then
		raise exception 'Good will: the month is YYYY-MM' using errcode = '22023';
	else
		v_month := (p_month || '-01')::date;
	end if;
	if v_month > date_trunc('month', public.qorpera_good_will_today())::date then
		raise exception 'Good will: % has not begun', to_char(v_month, 'YYYY-MM') using errcode = '22023'; end if;
	perform public.qorpera_good_will_gather(v_run.profile_id, public.qorpera_good_will_today());
	v_row := public.qorpera_good_will_recompute(v_run.profile_id, v_month, public.qorpera_good_will_today());
	if v_row.profile_id is null then
		raise exception 'Good will: % is before the company''s good will began', to_char(v_month, 'YYYY-MM')
			using errcode = '22023'; end if;
	-- The unsorted first when there are more than 300.
	select count(*), coalesce(jsonb_agg(public.qorpera_good_will_item_json(listed.item)
		order by (listed.item).booked_on, (listed.item).id) filter (where listed.rank <= 300), '[]'::jsonb)
	into v_total, v_items
	from (select i as item, row_number() over (order by i.counted is not null, i.booked_on, i.id) as rank
		from public.qorpera_good_will_items as i where i.profile_id = v_run.profile_id and i.month = v_month) as listed;
	return jsonb_build_object('schema', 'qorpera.good-will-month/v1', 'runId', v_run.id,
		'month', public.qorpera_good_will_month_json(v_row), 'items', v_items, 'itemCount', v_total,
		'shown', least(v_total, 300));
end
$$;
revoke all on function public.qorpera_good_will_agent_list(jsonb, text) from public, anon, authenticated;
grant execute on function public.qorpera_good_will_agent_list(jsonb, text) to service_role;

-- Payments sorted, 1 to 100 at once, all or none: {"marks": [{"itemId", "reason", "momsOre"?, "note"?}]}. The same
-- marks again change nothing but the time.
create function public.qorpera_good_will_agent_mark(p_binding jsonb, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_run public.qorpera_execution_runs%rowtype; v_mark jsonb; v_answer jsonb; v_items jsonb := '[]'::jsonb;
	v_months jsonb := '{}'::jsonb; v_item uuid; v_moms bigint;
begin
	v_run := public.qorpera_good_will_agent_run(p_binding);
	if jsonb_typeof(p_request) is distinct from 'object' or jsonb_typeof(p_request -> 'marks') is distinct from 'array'
		or jsonb_array_length(p_request -> 'marks') not between 1 and 100 then
		raise exception 'Good will: marks is a list of 1 to 100 payments' using errcode = '22023'; end if;
	-- Months in ascending order, as a gather locks them, so two calls never wait on each other.
	for v_mark in
		select mark.value from jsonb_array_elements(p_request -> 'marks') with ordinality as mark(value, n)
		left join public.qorpera_good_will_items as i on i.profile_id = v_run.profile_id
			and i.id = case when mark.value ->> 'itemId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
				then (mark.value ->> 'itemId')::uuid end
		order by i.month nulls first, mark.n
	loop
		begin
			v_item := (v_mark ->> 'itemId')::uuid;
			v_moms := (v_mark ->> 'momsOre')::bigint;
		exception when invalid_text_representation or numeric_value_out_of_range then
			raise exception 'Good will: each mark has an itemId and whole øre' using errcode = '22023';
		end;
		if jsonb_typeof(v_mark) <> 'object' or v_item is null or jsonb_typeof(v_mark -> 'reason') is distinct from 'string'
			or (v_mark ? 'note' and jsonb_typeof(v_mark -> 'note') not in ('string', 'null')) then
			raise exception 'Good will: each mark has an itemId, a reason and maybe a note' using errcode = '22023'; end if;
		v_answer := public.qorpera_good_will_decide(v_run.profile_id, v_item, v_mark ->> 'reason', v_moms, v_mark ->> 'note',
			'agent', v_run.staff_agent_id, null);
		v_items := v_items || jsonb_build_array(v_answer -> 'item');
		v_months := v_months || jsonb_build_object(v_answer -> 'month' ->> 'month', v_answer -> 'month');
	end loop;
	return jsonb_build_object('schema', 'qorpera.good-will-marks/v1', 'runId', v_run.id, 'items', v_items,
		'months', (select jsonb_agg(value order by key) from jsonb_each(v_months)));
end
$$;
revoke all on function public.qorpera_good_will_agent_mark(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.qorpera_good_will_agent_mark(jsonb, jsonb) to service_role;

insert into public.qorpera_native_host_calls(name, scope) values
	('qorpera_good_will_agent_list', 'binding'), ('qorpera_good_will_agent_mark', 'binding');

-- 5. The members' calls -------------------------------------------------------------------------------------------------

-- The Company tab: the company's months (this one so far and the last twelve), the steps, and the card that pays.
create function public.qorpera_company_good_will(p_profile_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_role public.qorpera_profile_role; v_payer public.qorpera_good_will_payers%rowtype; v_today date;
begin
	if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
	v_role := public.qorpera_member_role(p_profile_id);
	if v_role is null then
		raise exception 'Only members of this company can read its good will' using errcode = '42501'; end if;
	v_today := public.qorpera_good_will_today();
	select * into v_payer from public.qorpera_good_will_payers as p where p.profile_id = p_profile_id;
	return jsonb_build_object('schema', 'qorpera.company-good-will/v1', 'profileId', p_profile_id,
		'companyName', (select p.name from public.qorpera_profiles as p where p.id = p_profile_id),
		'canAddCard', v_role = 'owner',
		'card', case when v_payer.profile_id is not null then jsonb_build_object('mine', v_payer.user_id = auth.uid(),
			'payerName', (select nullif(btrim(m.display_name), '') from public.qorpera_profile_members as m
				where m.profile_id = p_profile_id and m.user_id = v_payer.user_id),
			'brand', v_payer.brand, 'last4', v_payer.last4) end,
		'months', coalesce((select jsonb_agg(public.qorpera_good_will_month_json(m) order by m.month desc)
			from (select * from public.qorpera_good_will_months as m where m.profile_id = p_profile_id
				and m.month >= (date_trunc('month', v_today) - interval '12 months')::date order by m.month desc) as m), '[]'::jsonb),
		'steps', coalesce((public.qorpera_good_will_fee(0, date_trunc('month', v_today)::date) -> 'steps'), '[]'::jsonb),
		'minChargeOre', (public.qorpera_good_will_fee(0, date_trunc('month', v_today)::date) ->> 'minChargeOre')::bigint);
end
$$;
revoke all on function public.qorpera_company_good_will(uuid) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_company_good_will(uuid) to authenticated;

-- The account page with no company open: each of the member's companies this year (sold, good will, whose card), and
-- what the member's own card paid.
create function public.qorpera_my_good_will()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_user uuid := auth.uid(); v_year date;
begin
	if v_user is null then raise exception 'authentication required' using errcode = '42501'; end if;
	v_year := date_trunc('year', public.qorpera_good_will_today())::date;
	return jsonb_build_object('schema', 'qorpera.my-good-will/v1', 'year', extract(year from v_year)::integer,
		'paidByMeOre', coalesce((select sum(m.due_ore) from public.qorpera_good_will_months as m
			join public.qorpera_profile_members as member on member.profile_id = m.profile_id and member.user_id = v_user
			where m.status = 'charged' and m.payer_user_id = v_user and m.month >= v_year), 0),
		'companies', coalesce((select jsonb_agg(jsonb_build_object('profileId', p.id, 'name', p.name,
			'netOre', coalesce(totals.net_ore, 0), 'feeOre', coalesce(totals.fee_ore, 0),
			'rateBp', (select s.rate_bp from public.qorpera_good_will_steps as s
				where s.valid_from = (public.qorpera_good_will_fee(0, date_trunc('month', public.qorpera_good_will_today())::date)
					->> 'validFrom')::date order by s.lower_ore limit 1),
			'payer', case when payer.user_id is null then 'none' when payer.user_id = v_user then 'me' else 'other' end,
			'brand', case when payer.user_id = v_user then payer.brand end,
			'last4', case when payer.user_id = v_user then payer.last4 end) order by p.name, p.id)
			from public.qorpera_profile_members as member
			join public.qorpera_profiles as p on p.id = member.profile_id
			left join public.qorpera_good_will_payers as payer on payer.profile_id = p.id
			left join lateral (select sum(m.net_ore) as net_ore, sum(m.fee_ore) as fee_ore
				from public.qorpera_good_will_months as m where m.profile_id = p.id and m.month >= v_year) as totals on true
			where member.user_id = v_user
				and not exists (select 1 from public.qorpera_company_deletions as d where d.profile_id = p.id)), '[]'::jsonb));
end
$$;
revoke all on function public.qorpera_my_good_will() from public, anon, authenticated, service_role;
grant execute on function public.qorpera_my_good_will() to authenticated;

-- A member's own sort of one payment (owners, admins and contributors; viewers read).
create function public.qorpera_mark_good_will_item(p_profile_id uuid, p_item_id uuid, p_reason text, p_moms_ore bigint,
	p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
	if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
	if public.qorpera_member_role(p_profile_id) is null or public.qorpera_member_role(p_profile_id) = 'viewer' then
		raise exception 'Only members who may write sort the company''s payments' using errcode = '42501'; end if;
	return jsonb_build_object('schema', 'qorpera.good-will-mark/v1') || public.qorpera_good_will_decide(p_profile_id,
		p_item_id, p_reason, p_moms_ore, p_note, 'member', null, auth.uid());
end
$$;
revoke all on function public.qorpera_mark_good_will_item(uuid, uuid, text, bigint, text)
	from public, anon, authenticated, service_role;
grant execute on function public.qorpera_mark_good_will_item(uuid, uuid, text, bigint, text) to authenticated;

-- 6. Billing: the computer-billing Edge Function's good will door --------------------------------------------------------
--
-- The Edge Function keeps using qorpera_computer_billing for its customers and its Stripe event records; good will has
-- its own door, behind the same keys. A founder saves the company's card on Stripe's own page (Checkout in setup
-- mode); a closed month is invoiced to it on the 5th. Before the live switch (qorpera_computer_hour_dry_run) a live key
-- invoices nothing, and Stripe's test mode is open to enrolled testers only, as for computer hours.
create function public.qorpera_good_will_billing(p_key text, p_method text, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_livemode boolean; v_user uuid; v_profile uuid; v_setup public.qorpera_good_will_card_setups%rowtype;
	v_row public.qorpera_good_will_months%rowtype; v_rows integer;
begin
	if p_key is null or not exists (
		select 1 from public.qorpera_computer_hour_billing_keys as billing_key
		where billing_key.key_sha256 = encode(extensions.digest(p_key, 'sha256'), 'hex') and billing_key.revoked_at is null
	) then
		raise exception 'Billing key refused' using errcode = '42501';
	end if;
	if jsonb_typeof(p_args) is distinct from 'object' then
		raise exception 'Billing: arguments must be an object' using errcode = '22023';
	end if;
	v_livemode := coalesce((p_args ->> 'livemode')::boolean, false);

	if p_method = 'card_begin' then
		-- A founder opens the card page for their company.
		v_user := (p_args ->> 'userId')::uuid;
		v_profile := (p_args ->> 'profileId')::uuid;
		if not public.qorpera_computer_billing_open(v_user, v_livemode) then
			return jsonb_build_object('refused', 'not_open');
		end if;
		if v_profile is null or not exists (
			select 1 from public.qorpera_company_founders(v_profile) as founder where founder.user_id = v_user
		) then
			return jsonb_build_object('refused', 'not_a_founder');
		end if;
		insert into public.qorpera_good_will_card_setups (profile_id, user_id, livemode)
		values (v_profile, v_user, v_livemode)
		returning * into v_setup;
		return jsonb_build_object('setupId', v_setup.id,
			'companyName', (select p.name from public.qorpera_profiles as p where p.id = v_profile),
			'customerId', (select customer.stripe_customer_id from public.qorpera_good_will_customers as customer
				where customer.profile_id = v_profile and customer.livemode = v_livemode));

	elsif p_method = 'customer_set' then
		-- The company's own Stripe customer; the first one saved stays.
		v_profile := (p_args ->> 'profileId')::uuid;
		insert into public.qorpera_good_will_customers (profile_id, livemode, stripe_customer_id)
		values (v_profile, v_livemode, p_args ->> 'customerId')
		on conflict (profile_id, livemode) do nothing;
		return jsonb_build_object('customerId', (select customer.stripe_customer_id from public.qorpera_good_will_customers as customer
			where customer.profile_id = v_profile and customer.livemode = v_livemode));

	elsif p_method = 'card_attach' then
		update public.qorpera_good_will_card_setups set stripe_session_id = p_args ->> 'sessionId'
		where id = (p_args ->> 'setupId')::uuid and stripe_session_id is null;
		get diagnostics v_rows = row_count;
		return jsonb_build_object('attached', v_rows = 1);

	elsif p_method = 'card_saved' then
		-- Stripe's completed setup page (re-read from Stripe): the card pays the company's good will from now on, while
		-- the member who saved it is still a founder.
		-- Found by its session, or by the page's own id when its session was never attached (Stripe made the page, the
		-- attach failed).
		select * into v_setup from public.qorpera_good_will_card_setups as setup
		where setup.livemode = v_livemode and (setup.stripe_session_id = p_args ->> 'sessionId'
			or (setup.stripe_session_id is null and setup.id::text = p_args ->> 'setupId'))
		for update;
		if v_setup.id is null then
			return jsonb_build_object('outcome', 'ignored', 'detail', 'no such card page');
		end if;
		if v_setup.completed_at is not null then
			return jsonb_build_object('outcome', 'applied', 'detail', 'already saved');
		end if;
		if not exists (select 1 from public.qorpera_company_founders(v_setup.profile_id) as founder
			where founder.user_id = v_setup.user_id) then
			return jsonb_build_object('outcome', 'ignored', 'detail', 'no longer a founder');
		end if;
		insert into public.qorpera_good_will_payers as payer (profile_id, user_id, livemode, stripe_customer_id,
			payment_method_id, brand, last4)
		values (v_setup.profile_id, v_setup.user_id, v_livemode, p_args ->> 'customerId', p_args ->> 'paymentMethodId',
			nullif(p_args ->> 'brand', ''), nullif(p_args ->> 'last4', ''))
		on conflict (profile_id) do update
		set user_id = excluded.user_id, livemode = excluded.livemode, stripe_customer_id = excluded.stripe_customer_id,
			payment_method_id = excluded.payment_method_id, brand = excluded.brand, last4 = excluded.last4,
			saved_at = clock_timestamp();
		update public.qorpera_good_will_card_setups
		set completed_at = clock_timestamp(), stripe_session_id = coalesce(stripe_session_id, p_args ->> 'sessionId')
		where id = v_setup.id;
		return jsonb_build_object('outcome', 'applied', 'profileId', v_setup.profile_id);

	elsif p_method = 'due' then
		-- Closed months whose company has a card in this mode, paid by a founder, with their invoice once one is made
		-- (a draft is finished on the next call). Live: none before the live switch, and never a month that turned final
		-- before it (those were dry runs). Test mode: only enrolled testers' cards.
		if v_livemode and public.qorpera_computer_hour_dry_run(clock_timestamp()) then
			return jsonb_build_object('months', '[]'::jsonb, 'held', 'dry_run');
		end if;
		return jsonb_build_object('months', coalesce((select jsonb_agg(jsonb_build_object('profileId', m.profile_id,
			'month', to_char(m.month, 'YYYY-MM'), 'dueOre', m.due_ore, 'netOre', m.net_ore,
			'companyName', p.name, 'userId', payer.user_id, 'customerId', payer.stripe_customer_id,
			'paymentMethodId', payer.payment_method_id, 'invoiceId', m.stripe_invoice_id) order by m.month, m.profile_id)
			from public.qorpera_good_will_months as m
			join public.qorpera_good_will_payers as payer on payer.profile_id = m.profile_id and payer.livemode = v_livemode
			join public.qorpera_profiles as p on p.id = m.profile_id
			where m.status = 'closed' and (m.stripe_invoice_id is null or m.livemode = v_livemode)
				and (not v_livemode or not public.qorpera_computer_hour_dry_run(m.final_at))
				and exists (select 1 from public.qorpera_company_founders(m.profile_id) as founder
					where founder.user_id = payer.user_id)
				and (v_livemode or public.qorpera_computer_billing_tester(payer.user_id))), '[]'::jsonb));

	elsif p_method = 'invoiced' then
		-- The month's invoice, recorded as a draft first (so a retry finishes it, never makes a second), then again with
		-- its page once finalized; it is charged when Stripe says it is paid.
		update public.qorpera_good_will_months as m
		set stripe_invoice_id = p_args ->> 'invoiceId', invoice_url = coalesce(nullif(p_args ->> 'invoiceUrl', ''), m.invoice_url),
			livemode = v_livemode, payer_user_id = (p_args ->> 'userId')::uuid, updated_at = clock_timestamp()
		where m.profile_id = (p_args ->> 'profileId')::uuid and m.month = ((p_args ->> 'month') || '-01')::date
			and m.status = 'closed' and (m.stripe_invoice_id is null
				or (m.stripe_invoice_id = p_args ->> 'invoiceId' and m.livemode = v_livemode));
		get diagnostics v_rows = row_count;
		return jsonb_build_object('recorded', v_rows = 1);

	elsif p_method in ('invoice_paid', 'invoice_failed') then
		-- Paid: charged (also after a failed try, since Stripe tries the card again). Failed: we post a reminder in chat.
		update public.qorpera_good_will_months as m
		set status = case when p_method = 'invoice_paid' then 'charged' else 'failed' end,
			charged_at = case when p_method = 'invoice_paid' then clock_timestamp() end,
			stripe_invoice_id = p_args ->> 'invoiceId', livemode = v_livemode,
			invoice_url = coalesce(nullif(p_args ->> 'invoiceUrl', ''), m.invoice_url), updated_at = clock_timestamp()
		where m.status = any (case when p_method = 'invoice_paid' then array['closed', 'failed'] else array['closed'] end)
			and ((m.stripe_invoice_id = p_args ->> 'invoiceId' and m.livemode = v_livemode)
				-- Stripe's word before the invoice was recorded: the month its metadata names.
				or (m.stripe_invoice_id is null and m.profile_id::text = p_args ->> 'profileId'
					and to_char(m.month, 'YYYY-MM') = p_args ->> 'month'))
		returning * into v_row;
		if v_row.profile_id is null then
			return jsonb_build_object('outcome', 'ignored', 'detail', 'no good will month waits on this invoice');
		end if;
		return jsonb_build_object('outcome', 'applied', 'profileId', v_row.profile_id, 'status', v_row.status);
	end if;
	raise exception 'Billing: unknown good will method' using errcode = '22023';
end
$$;
revoke all on function public.qorpera_good_will_billing(text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.qorpera_good_will_billing(text, text, jsonb) to service_role;

-- 7. The clock ----------------------------------------------------------------------------------------------------------

-- Each company with a bank connection or good will rows: its payments gathered, last month sorting from the 1st, and
-- final from the 5th. A company that fails is told in the log and tried again next time; the others go on. Then the
-- billing function is called to invoice what closed, when its project address and key are in the Vault.
create function public.qorpera_good_will_tick(p_today date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_today date := coalesce(p_today, public.qorpera_good_will_today()); v_profile uuid; v_month date;
	v_companies integer := 0;
	v_final integer := 0; v_failed integer := 0; v_url text; v_key text;
begin
	for v_profile in
		select s.profile_id from public.qorpera_bank_syncs as s
		union select m.profile_id from public.qorpera_good_will_months as m where m.status in ('open', 'sorting')
	loop
		begin
			perform public.qorpera_good_will_gather(v_profile, v_today);
			if extract(day from v_today) >= 5 then
				for v_month in select m.month from public.qorpera_good_will_months as m
					where m.profile_id = v_profile and m.status = 'sorting' and m.month < date_trunc('month', v_today)::date
					order by m.month
				loop
					perform public.qorpera_good_will_finalize(v_profile, v_month, v_today);
					v_final := v_final + 1;
				end loop;
			end if;
			v_companies := v_companies + 1;
		exception when others then
			v_failed := v_failed + 1;
			raise warning 'Good will for % was not gathered: %', v_profile, sqlerrm;
		end;
	end loop;
	if exists (select 1 from public.qorpera_good_will_months as m
			join public.qorpera_good_will_payers as payer on payer.profile_id = m.profile_id
			where m.status = 'closed' and m.stripe_invoice_id is null)
		and to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is not null
		and to_regclass('vault.decrypted_secrets') is not null then
		begin
			execute 'select (select decrypted_secret from vault.decrypted_secrets where name = ''qorpera_project_url''),
				(select decrypted_secret from vault.decrypted_secrets where name = ''qorpera_computer_billing_key'')'
			into v_url, v_key;
			if v_url is not null and v_key is not null then
				execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := $2, timeout_milliseconds := 120000)'
				using v_url || '/functions/v1/computer-billing/good-will-invoices',
					jsonb_build_object('content-type', 'application/json', 'x-qorpera-billing-key', v_key);
			end if;
		exception when others then
			raise warning 'Good will invoices were not asked for: %', sqlerrm;
		end;
	end if;
	return jsonb_build_object('schema', 'qorpera.good-will-tick/v1', 'companies', v_companies, 'finalized', v_final,
		'failed', v_failed);
end
$$;
revoke all on function public.qorpera_good_will_tick(date) from public, anon, authenticated, service_role;

-- Every hour at :17, as the role that runs this (run it again as the role that should own the job after pg_cron is
-- enabled).
create function public.qorpera_schedule_good_will()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare v_job bigint;
begin
	if to_regnamespace('cron') is null or to_regprocedure('cron.schedule(text,text,text)') is null then
		raise notice 'Good will was not scheduled: pg_cron is not installed here';
		return jsonb_build_object('schema', 'qorpera.good-will-schedule/v1', 'scheduled', false);
	end if;
	begin
		v_job := cron.schedule('qorpera-good-will', '17 * * * *', 'select public.qorpera_good_will_tick()');
	exception when others then
		raise warning 'Good will was not scheduled (%): % may not use pg_cron', sqlerrm, current_user;
		return jsonb_build_object('schema', 'qorpera.good-will-schedule/v1', 'scheduled', false);
	end;
	return jsonb_build_object('schema', 'qorpera.good-will-schedule/v1', 'scheduled', true, 'job', v_job);
end
$$;
revoke all on function public.qorpera_schedule_good_will() from public, anon, authenticated, service_role;
select public.qorpera_schedule_good_will();
