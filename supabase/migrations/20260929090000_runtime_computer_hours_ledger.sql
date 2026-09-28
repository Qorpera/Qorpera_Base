-- Computer hours, build step 3: the billing records and the charging order, as a dry run.
-- Contract: section 19, 2026-09-28 amendment "computer hours", items 4, 5, 7 (owed time), 9 and 12.
-- Design: deploy/first-node/RUNTIME-COMPUTER-HOURS.md ("Billing records").
--
-- Every usage row the meter writes (20260928248000) is charged when it is inserted, by an AFTER
-- INSERT trigger on qorpera_computer_hour_usage; the meter itself is not copied or changed. Each
-- second is paid from the first source with hours left:
--   1. the company's five free hours;
--   2. its founders' current plan periods, split evenly between the founders with hours left;
--   3. its purchased credits, the soonest to expire first;
--   4. otherwise it is owed, and owed time is paid first, in the same order, from later hours.
-- A company with a founder on an internal account is complimentary: its time is recorded as paid
-- by a complimentary source naming the first such founder, instead of the order above.
-- Members who are not founders are never a source.
--
-- Until an operator sets qorpera_computer_hour_billing.live_since (with live payments, build
-- step 7), every source and draw is a dry run: it shows who would have paid. Live records start
-- fresh at the switch; dry-run records are never counted in live balances. Nothing here charges a
-- card or stops work. Billing records carry no foreign key to qorpera_profiles or auth.users: they
-- outlive the company and the account for bookkeeping.

create table public.qorpera_computer_hour_billing (
	id boolean primary key default true check (id),
	-- Null while billing is a dry run.
	live_since timestamptz
);
insert into public.qorpera_computer_hour_billing (id, live_since) values (true, null);

create table public.qorpera_computer_hour_sources (
	id uuid primary key default extensions.gen_random_uuid(),
	kind text not null check (kind in ('free', 'plan_period', 'credit', 'complimentary', 'owed')),
	-- The company, for free hours, credits, complimentary time and owed time.
	profile_id uuid,
	-- The founder whose plan it is, the founder who bought the credits, or the internal founder.
	user_id uuid,
	-- Standard seconds. Null for complimentary and owed sources, which have no limit.
	granted_seconds bigint check (granted_seconds is null or granted_seconds >= 0),
	drawn_seconds bigint not null default 0 check (drawn_seconds >= 0),
	-- Owed time paid back from later hours.
	repaid_seconds bigint not null default 0 check (repaid_seconds >= 0),
	period_start timestamptz,
	period_end timestamptz,
	expires_at timestamptz,
	-- The unused part is taken back (a plan payment that finally failed, a refund).
	withdrawn_at timestamptz,
	-- No new draws while a dispute is open.
	frozen_at timestamptz,
	reference text check (reference is null or char_length(reference) between 1 and 256),
	dry_run boolean not null,
	created_at timestamptz not null default clock_timestamp(),
	check (granted_seconds is null or drawn_seconds <= granted_seconds),
	check ((kind in ('complimentary', 'owed')) = (granted_seconds is null)),
	check (kind = 'owed' or repaid_seconds = 0),
	check (kind <> 'owed' or repaid_seconds <= drawn_seconds),
	check (kind = 'plan_period' or profile_id is not null),
	check (kind not in ('plan_period', 'credit', 'complimentary') or user_id is not null),
	check (kind <> 'plan_period' or (profile_id is null and period_start is not null and period_end > period_start)),
	check (kind <> 'credit' or expires_at is not null)
);
create unique index qorpera_computer_hour_sources_free on public.qorpera_computer_hour_sources (profile_id, dry_run)
	where kind = 'free';
create unique index qorpera_computer_hour_sources_owed on public.qorpera_computer_hour_sources (profile_id, dry_run)
	where kind = 'owed';
create unique index qorpera_computer_hour_sources_complimentary
	on public.qorpera_computer_hour_sources (profile_id, user_id, dry_run) where kind = 'complimentary';
create index qorpera_computer_hour_sources_plans on public.qorpera_computer_hour_sources (user_id, period_end)
	where kind = 'plan_period';
create index qorpera_computer_hour_sources_credits on public.qorpera_computer_hour_sources (profile_id, expires_at)
	where kind = 'credit';

-- Which sources paid for each usage row.
create table public.qorpera_computer_hour_draws (
	usage_id bigint not null references public.qorpera_computer_hour_usage(id) on delete restrict,
	source_id uuid not null references public.qorpera_computer_hour_sources(id) on delete restrict,
	standard_seconds bigint not null check (standard_seconds > 0),
	primary key (usage_id, source_id)
);
create index qorpera_computer_hour_draws_source on public.qorpera_computer_hour_draws (source_id);

-- Owed time paid back from a later source.
create table public.qorpera_computer_hour_repayments (
	id bigint generated always as identity primary key,
	owed_source_id uuid not null references public.qorpera_computer_hour_sources(id) on delete restrict,
	source_id uuid not null references public.qorpera_computer_hour_sources(id) on delete restrict,
	standard_seconds bigint not null check (standard_seconds > 0),
	created_at timestamptz not null default clock_timestamp()
);
create index qorpera_computer_hour_repayments_owed on public.qorpera_computer_hour_repayments (owed_source_id);

create trigger qorpera_computer_hour_draws_append_only
	before update or delete on public.qorpera_computer_hour_draws
	for each row execute function public.qorpera_computer_hour_append_only();
create trigger qorpera_computer_hour_repayments_append_only
	before update or delete on public.qorpera_computer_hour_repayments
	for each row execute function public.qorpera_computer_hour_append_only();

alter table public.qorpera_computer_hour_billing enable row level security;
alter table public.qorpera_computer_hour_sources enable row level security;
alter table public.qorpera_computer_hour_draws enable row level security;
alter table public.qorpera_computer_hour_repayments enable row level security;
revoke all on public.qorpera_computer_hour_billing, public.qorpera_computer_hour_sources,
	public.qorpera_computer_hour_draws, public.qorpera_computer_hour_repayments
	from public, anon, authenticated, service_role;
grant select on public.qorpera_computer_hour_billing, public.qorpera_computer_hour_sources,
	public.qorpera_computer_hour_draws, public.qorpera_computer_hour_repayments
	to service_role;
revoke all on sequence public.qorpera_computer_hour_repayments_id_seq from public, anon, authenticated, service_role;

-- The first founder of the company on an internal account, or null.
create function public.qorpera_computer_hour_complimentary_founder(p_profile_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
	select founder.user_id
	from public.qorpera_company_founders(p_profile_id) with ordinality as founder(user_id, position)
	join public.qorpera_account_entitlements entitlement
		on entitlement.user_id = founder.user_id and entitlement.plan_key = 'internal'
	order by founder.position
	limit 1
$$;
revoke all on function public.qorpera_computer_hour_complimentary_founder(uuid) from public, anon, authenticated, service_role;

-- The company's source of a kind with one row per company (free or owed), created when first needed.
create function public.qorpera_computer_hour_company_source(p_profile_id uuid, p_kind text, p_dry_run boolean)
returns public.qorpera_computer_hour_sources
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_source public.qorpera_computer_hour_sources%rowtype;
begin
	if p_kind not in ('free', 'owed') then
		raise exception 'Not a per-company source: %', p_kind using errcode = '22023';
	end if;
	insert into public.qorpera_computer_hour_sources (kind, profile_id, granted_seconds, dry_run)
	values (p_kind, p_profile_id, case when p_kind = 'free' then 5 * 3600 end, p_dry_run)
	on conflict do nothing;
	select * into strict v_source from public.qorpera_computer_hour_sources
	where kind = p_kind and profile_id = p_profile_id and dry_run = p_dry_run
	for update;
	return v_source;
end
$$;
revoke all on function public.qorpera_computer_hour_company_source(uuid, text, boolean)
	from public, anon, authenticated, service_role;

-- Pays p_seconds of the company's time at p_at from its free hours, then its founders' plans
-- (evenly), then its credits. Records draws for a usage row, or repayments of an owed source.
-- Returns the seconds nothing could pay.
create function public.qorpera_computer_hour_pay(
	p_profile_id uuid,
	p_seconds bigint,
	p_at timestamptz,
	p_dry_run boolean,
	p_usage_id bigint,
	p_owed_source_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_left bigint := p_seconds;
	v_paid jsonb := '{}'::jsonb;
	v_free public.qorpera_computer_hour_sources%rowtype;
	v_take bigint;
	v_plans uuid[];
	v_room bigint[];
	v_count integer;
	v_share bigint;
	v_extra bigint;
	v_index integer;
	v_source record;
	v_key text;
begin
	if (p_usage_id is null) = (p_owed_source_id is null) or p_seconds < 0 then
		raise exception 'A payment is for one usage row or one owed source' using errcode = '22023';
	end if;
	-- 1. Free hours.
	if v_left > 0 then
		v_free := public.qorpera_computer_hour_company_source(p_profile_id, 'free', p_dry_run);
		v_take := least(v_left, v_free.granted_seconds - v_free.drawn_seconds);
		if v_take > 0 then
			v_paid := v_paid || jsonb_build_object(v_free.id::text, v_take);
			v_left := v_left - v_take;
		end if;
	end if;
	-- 2. The founders' current plan periods, evenly between those with hours left. The most hours
	-- left gets a remainder second first; when one runs out, the others carry the rest.
	while v_left > 0 loop
		select coalesce(array_agg(plan.id order by plan.granted_seconds - plan.drawn_seconds
				- coalesce((v_paid ->> plan.id::text)::bigint, 0) desc, plan.id), '{}'),
			coalesce(array_agg(plan.granted_seconds - plan.drawn_seconds - coalesce((v_paid ->> plan.id::text)::bigint, 0)
				order by plan.granted_seconds - plan.drawn_seconds - coalesce((v_paid ->> plan.id::text)::bigint, 0) desc, plan.id), '{}')
		into v_plans, v_room
		from public.qorpera_computer_hour_sources plan
		join public.qorpera_company_founders(p_profile_id) founder on founder.user_id = plan.user_id
		where plan.kind = 'plan_period' and plan.dry_run = p_dry_run and plan.withdrawn_at is null and plan.frozen_at is null
			and plan.period_start <= p_at and p_at < plan.period_end
			and plan.granted_seconds - plan.drawn_seconds - coalesce((v_paid ->> plan.id::text)::bigint, 0) > 0;
		v_count := cardinality(v_plans);
		exit when v_count = 0;
		v_share := v_left / v_count;
		v_extra := v_left % v_count;
		for v_index in 1 .. v_count loop
			v_take := least(v_share + case when v_index <= v_extra then 1 else 0 end, v_room[v_index]);
			if v_take > 0 then
				v_key := v_plans[v_index]::text;
				v_paid := v_paid || jsonb_build_object(v_key, coalesce((v_paid ->> v_key)::bigint, 0) + v_take);
				v_left := v_left - v_take;
			end if;
		end loop;
	end loop;
	-- 3. Credits, the soonest to expire first.
	for v_source in
		select credit.id, credit.granted_seconds - credit.drawn_seconds as room
		from public.qorpera_computer_hour_sources credit
		where credit.kind = 'credit' and credit.profile_id = p_profile_id and credit.dry_run = p_dry_run
			and credit.withdrawn_at is null and credit.frozen_at is null and credit.expires_at > p_at
			and credit.granted_seconds > credit.drawn_seconds
		order by credit.expires_at, credit.id
	loop
		exit when v_left = 0;
		v_take := least(v_left, v_source.room);
		v_paid := v_paid || jsonb_build_object(v_source.id::text, v_take);
		v_left := v_left - v_take;
	end loop;
	-- Record what each source paid. Sources are locked in id order, so two payers never deadlock.
	for v_key in select key from jsonb_each(v_paid) order by key::uuid loop
		v_take := (v_paid ->> v_key)::bigint;
		update public.qorpera_computer_hour_sources set drawn_seconds = drawn_seconds + v_take
		where id = v_key::uuid;
		if p_usage_id is not null then
			insert into public.qorpera_computer_hour_draws (usage_id, source_id, standard_seconds)
			values (p_usage_id, v_key::uuid, v_take);
		else
			insert into public.qorpera_computer_hour_repayments (owed_source_id, source_id, standard_seconds)
			values (p_owed_source_id, v_key::uuid, v_take);
		end if;
	end loop;
	return v_left;
end
$$;
revoke all on function public.qorpera_computer_hour_pay(uuid, bigint, timestamptz, boolean, bigint, uuid)
	from public, anon, authenticated, service_role;

-- Charges one usage row as the meter inserts it.
create function public.qorpera_computer_hour_charge_usage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_dry_run boolean;
	v_founder uuid;
	v_source public.qorpera_computer_hour_sources%rowtype;
	v_owed public.qorpera_computer_hour_sources%rowtype;
	v_left bigint;
begin
	if new.standard_seconds = 0 then
		return null;
	end if;
	select billing.live_since is null into strict v_dry_run from public.qorpera_computer_hour_billing billing;
	v_founder := public.qorpera_computer_hour_complimentary_founder(new.profile_id);
	if v_founder is not null then
		insert into public.qorpera_computer_hour_sources (kind, profile_id, user_id, dry_run)
		values ('complimentary', new.profile_id, v_founder, v_dry_run)
		on conflict do nothing;
		select * into strict v_source from public.qorpera_computer_hour_sources
		where kind = 'complimentary' and profile_id = new.profile_id and user_id = v_founder and dry_run = v_dry_run
		for update;
		update public.qorpera_computer_hour_sources set drawn_seconds = drawn_seconds + new.standard_seconds
		where id = v_source.id;
		insert into public.qorpera_computer_hour_draws (usage_id, source_id, standard_seconds)
		values (new.id, v_source.id, new.standard_seconds);
		return null;
	end if;
	-- Owed time is paid first.
	select * into v_owed from public.qorpera_computer_hour_sources
	where kind = 'owed' and profile_id = new.profile_id and dry_run = v_dry_run
	for update;
	if found and v_owed.drawn_seconds > v_owed.repaid_seconds then
		v_left := public.qorpera_computer_hour_pay(new.profile_id, v_owed.drawn_seconds - v_owed.repaid_seconds,
			new.metered_at, v_dry_run, null, v_owed.id);
		update public.qorpera_computer_hour_sources
		set repaid_seconds = drawn_seconds - v_left
		where id = v_owed.id;
	end if;
	v_left := public.qorpera_computer_hour_pay(new.profile_id, new.standard_seconds, new.metered_at, v_dry_run, new.id, null);
	if v_left > 0 then
		v_owed := public.qorpera_computer_hour_company_source(new.profile_id, 'owed', v_dry_run);
		update public.qorpera_computer_hour_sources set drawn_seconds = drawn_seconds + v_left where id = v_owed.id;
		insert into public.qorpera_computer_hour_draws (usage_id, source_id, standard_seconds)
		values (new.id, v_owed.id, v_left);
	end if;
	return null;
end
$$;
revoke all on function public.qorpera_computer_hour_charge_usage() from public, anon, authenticated, service_role;
create trigger qorpera_computer_hour_charge_usage
	after insert on public.qorpera_computer_hour_usage
	for each row execute function public.qorpera_computer_hour_charge_usage();

-- The company's hours left now, in standard seconds: its free hours, its founders' current plan
-- periods and its credits, minus what it owes. Null for a complimentary company, which has no
-- limit. In the current mode (dry run or live).
create function public.qorpera_company_computer_hours_left(p_profile_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_dry_run boolean;
	v_now timestamptz := clock_timestamp();
	v_left bigint;
begin
	if public.qorpera_computer_hour_complimentary_founder(p_profile_id) is not null then
		return null;
	end if;
	select billing.live_since is null into strict v_dry_run from public.qorpera_computer_hour_billing billing;
	select
		-- Free hours not created yet are all still there.
		coalesce((select free.granted_seconds - free.drawn_seconds from public.qorpera_computer_hour_sources free
			where free.kind = 'free' and free.profile_id = p_profile_id and free.dry_run = v_dry_run), 5 * 3600)
		+ coalesce((select sum(plan.granted_seconds - plan.drawn_seconds)
			from public.qorpera_computer_hour_sources plan
			join public.qorpera_company_founders(p_profile_id) founder on founder.user_id = plan.user_id
			where plan.kind = 'plan_period' and plan.dry_run = v_dry_run and plan.withdrawn_at is null
				and plan.frozen_at is null and plan.period_start <= v_now and v_now < plan.period_end), 0)
		+ coalesce((select sum(credit.granted_seconds - credit.drawn_seconds)
			from public.qorpera_computer_hour_sources credit
			where credit.kind = 'credit' and credit.profile_id = p_profile_id and credit.dry_run = v_dry_run
				and credit.withdrawn_at is null and credit.frozen_at is null and credit.expires_at > v_now), 0)
		- coalesce((select owed.drawn_seconds - owed.repaid_seconds from public.qorpera_computer_hour_sources owed
			where owed.kind = 'owed' and owed.profile_id = p_profile_id and owed.dry_run = v_dry_run), 0)
	into v_left;
	return v_left;
end
$$;
revoke all on function public.qorpera_company_computer_hours_left(uuid) from public, anon, authenticated;
grant execute on function public.qorpera_company_computer_hours_left(uuid) to service_role;

-- For operators: the company's sources in the current mode, with what each has paid.
create function public.qorpera_read_company_computer_hour_sources(p_profile_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
	select jsonb_build_object(
		'schema', 'qorpera.company-computer-hour-sources/v1',
		'profileId', p_profile_id,
		'mode', case when billing.live_since is null then 'dry_run' else 'live' end,
		'liveSince', billing.live_since,
		'hoursLeftSeconds', public.qorpera_company_computer_hours_left(p_profile_id),
		'sources', coalesce((
			select jsonb_agg(jsonb_build_object(
				'sourceId', source.id, 'kind', source.kind, 'userId', source.user_id,
				'grantedSeconds', source.granted_seconds, 'drawnSeconds', source.drawn_seconds,
				'repaidSeconds', source.repaid_seconds, 'periodStart', source.period_start,
				'periodEnd', source.period_end, 'expiresAt', source.expires_at,
				'withdrawnAt', source.withdrawn_at, 'frozenAt', source.frozen_at
			) order by source.created_at, source.id)
			from public.qorpera_computer_hour_sources source
			where source.dry_run = (billing.live_since is null)
				and (source.profile_id = p_profile_id or (source.kind = 'plan_period'
					and source.user_id in (select founder.user_id from public.qorpera_company_founders(p_profile_id) founder)))
		), '[]'::jsonb)
	)
	from public.qorpera_computer_hour_billing billing
$$;
revoke all on function public.qorpera_read_company_computer_hour_sources(uuid) from public, anon, authenticated;
grant execute on function public.qorpera_read_company_computer_hour_sources(uuid) to service_role;
