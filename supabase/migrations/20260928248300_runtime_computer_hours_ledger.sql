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
-- step 7), every source and draw is a dry run: it shows who would have paid. Usage metered before
-- live_since stays a dry run. Live records start fresh at the switch; dry-run records are never
-- counted in live balances. Every writer of billing records takes the meter's advisory lock first
-- (qorpera_computer_hour_lock_billing), so charges, arriving hours, refunds and freezes never
-- interleave; charging also locks the sources it may draw from, in id order. Nothing here charges a
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

-- Owed time paid back from a later source: when that source arrives, or at the company's next use
-- (then named by usage_id).
create table public.qorpera_computer_hour_repayments (
	id bigint generated always as identity primary key,
	owed_source_id uuid not null references public.qorpera_computer_hour_sources(id) on delete restrict,
	source_id uuid not null references public.qorpera_computer_hour_sources(id) on delete restrict,
	usage_id bigint references public.qorpera_computer_hour_usage(id) on delete restrict,
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

-- Serialises every writer of billing records with the meter's passes.
create function public.qorpera_computer_hour_lock_billing()
returns void
language sql
set search_path = ''
as $$
	select pg_advisory_xact_lock(hashtextextended('qorpera.computer-hour-meter', 0))
$$;
revoke all on function public.qorpera_computer_hour_lock_billing() from public, anon, authenticated, service_role;

-- Every statement that writes sources takes the billing lock before it touches a row, so a writer
-- whose first contact with billing records is a write cannot deadlock with a meter pass (which
-- already holds it; taking it again in the same transaction is immediate). A writer that locks
-- sources another way first (SELECT ... FOR UPDATE) must take qorpera_computer_hour_lock_billing()
-- before that.
create function public.qorpera_computer_hour_lock_sources()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	perform public.qorpera_computer_hour_lock_billing();
	return null;
end
$$;
revoke all on function public.qorpera_computer_hour_lock_sources() from public, anon, authenticated, service_role;
create trigger qorpera_computer_hour_lock_sources
	before insert or update or delete on public.qorpera_computer_hour_sources
	for each statement execute function public.qorpera_computer_hour_lock_sources();

-- True while time at p_at is a dry run: billing is not live, or went live after p_at.
create function public.qorpera_computer_hour_dry_run(p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select billing.live_since is null or billing.live_since > p_at from public.qorpera_computer_hour_billing billing
$$;
revoke all on function public.qorpera_computer_hour_dry_run(timestamptz) from public, anon, authenticated, service_role;

-- The company's free or owed source (one per company and mode), created when first needed.
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
	where kind = p_kind and profile_id = p_profile_id and dry_run = p_dry_run;
	return v_source;
end
$$;
revoke all on function public.qorpera_computer_hour_company_source(uuid, text, boolean)
	from public, anon, authenticated, service_role;

-- Pays p_seconds of the company's time at p_at from its free hours, then its founders' current
-- plan periods (evenly between the founders with hours left), then its credits (the soonest to
-- expire first). Records draws for a usage row (p_owed_source_id null) or repayments of an owed
-- source (then p_usage_id, if any, names the use that triggered them). Returns the seconds
-- nothing could pay.
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
	v_founders uuid[];
	v_free public.qorpera_computer_hour_sources%rowtype;
	v_take bigint;
	v_rest bigint;
	v_users uuid[];
	v_rooms bigint[];
	v_count integer;
	v_share bigint;
	v_extra bigint;
	v_index integer;
	v_source record;
	v_key text;
begin
	if p_seconds < 0 or (p_owed_source_id is null and p_usage_id is null) then
		raise exception 'A payment is for a usage row or an owed source' using errcode = '22023';
	end if;
	if p_seconds = 0 then
		return 0;
	end if;
	v_founders := array(select founder.user_id from public.qorpera_company_founders(p_profile_id) founder);
	v_free := public.qorpera_computer_hour_company_source(p_profile_id, 'free', p_dry_run);
	-- Lock every source this payment may draw from, in id order, and read them after the lock.
	perform 1 from public.qorpera_computer_hour_sources source
	where source.dry_run = p_dry_run and (
		source.id = v_free.id
		or (source.kind = 'plan_period' and source.user_id = any(v_founders)
			and source.period_start <= p_at and p_at < source.period_end)
		or (source.kind = 'credit' and source.profile_id = p_profile_id and source.expires_at > p_at))
	order by source.id
	for update;
	select * into strict v_free from public.qorpera_computer_hour_sources where id = v_free.id;
	-- 1. Free hours.
	if v_free.withdrawn_at is null and v_free.frozen_at is null then
		v_take := least(v_left, v_free.granted_seconds - v_free.drawn_seconds);
		if v_take > 0 then
			v_paid := v_paid || jsonb_build_object(v_free.id::text, v_take);
			v_left := v_left - v_take;
		end if;
	end if;
	-- 2. The founders' current plan periods, evenly between the founders with hours left (one
	-- share per founder, however many plan rows they have). The most hours left gets a remainder
	-- second first; when one runs out, the others carry the rest. Within a founder, the period
	-- that ends soonest pays first.
	while v_left > 0 loop
		select coalesce(array_agg(founder.user_id order by founder.room desc, founder.user_id), '{}'),
			coalesce(array_agg(founder.room order by founder.room desc, founder.user_id), '{}')
		into v_users, v_rooms
		from (
			select plan.user_id,
				sum(plan.granted_seconds - plan.drawn_seconds - coalesce((v_paid ->> plan.id::text)::bigint, 0))::bigint as room
			from public.qorpera_computer_hour_sources plan
			where plan.kind = 'plan_period' and plan.dry_run = p_dry_run and plan.user_id = any(v_founders)
				and plan.withdrawn_at is null and plan.frozen_at is null
				and plan.period_start <= p_at and p_at < plan.period_end
			group by plan.user_id
		) founder
		where founder.room > 0;
		v_count := cardinality(v_users);
		exit when v_count = 0;
		v_share := v_left / v_count;
		v_extra := v_left % v_count;
		for v_index in 1 .. v_count loop
			v_take := least(v_share + case when v_index <= v_extra then 1 else 0 end, v_rooms[v_index]);
			v_rest := v_take;
			for v_source in
				select plan.id, plan.granted_seconds - plan.drawn_seconds - coalesce((v_paid ->> plan.id::text)::bigint, 0) as room
				from public.qorpera_computer_hour_sources plan
				where plan.kind = 'plan_period' and plan.dry_run = p_dry_run and plan.user_id = v_users[v_index]
					and plan.withdrawn_at is null and plan.frozen_at is null
					and plan.period_start <= p_at and p_at < plan.period_end
				order by plan.period_end, plan.id
			loop
				exit when v_rest = 0;
				continue when v_source.room <= 0;
				v_key := v_source.id::text;
				v_paid := v_paid || jsonb_build_object(v_key,
					coalesce((v_paid ->> v_key)::bigint, 0) + least(v_rest, v_source.room));
				v_rest := v_rest - least(v_rest, v_source.room);
			end loop;
			v_left := v_left - (v_take - v_rest);
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
	-- Record what each source paid.
	for v_key in select key from jsonb_each(v_paid) order by key::uuid loop
		v_take := (v_paid ->> v_key)::bigint;
		update public.qorpera_computer_hour_sources set drawn_seconds = drawn_seconds + v_take
		where id = v_key::uuid;
		if p_owed_source_id is null then
			insert into public.qorpera_computer_hour_draws (usage_id, source_id, standard_seconds)
			values (p_usage_id, v_key::uuid, v_take);
		else
			insert into public.qorpera_computer_hour_repayments (owed_source_id, source_id, usage_id, standard_seconds)
			values (p_owed_source_id, v_key::uuid, p_usage_id, v_take);
		end if;
	end loop;
	return v_left;
end
$$;
revoke all on function public.qorpera_computer_hour_pay(uuid, bigint, timestamptz, boolean, bigint, uuid)
	from public, anon, authenticated, service_role;

-- Pays what the company owes (in one mode) from the hours it has now. p_usage_id names the use
-- that triggered it, if any.
create function public.qorpera_computer_hour_repay(p_profile_id uuid, p_dry_run boolean, p_at timestamptz, p_usage_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_owed public.qorpera_computer_hour_sources%rowtype;
	v_left bigint;
begin
	select * into v_owed from public.qorpera_computer_hour_sources
	where kind = 'owed' and profile_id = p_profile_id and dry_run = p_dry_run
	for update;
	if not found or v_owed.drawn_seconds <= v_owed.repaid_seconds then
		return;
	end if;
	v_left := public.qorpera_computer_hour_pay(p_profile_id, v_owed.drawn_seconds - v_owed.repaid_seconds,
		p_at, p_dry_run, p_usage_id, v_owed.id);
	update public.qorpera_computer_hour_sources set repaid_seconds = drawn_seconds - v_left where id = v_owed.id;
end
$$;
revoke all on function public.qorpera_computer_hour_repay(uuid, boolean, timestamptz, bigint)
	from public, anon, authenticated, service_role;

-- Charges one usage row as the meter inserts it.
create function public.qorpera_computer_hour_charge_usage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_dry_run boolean := public.qorpera_computer_hour_dry_run(new.metered_at);
	v_founder uuid;
	v_source public.qorpera_computer_hour_sources%rowtype;
	v_owed public.qorpera_computer_hour_sources%rowtype;
	v_left bigint;
begin
	if new.standard_seconds = 0 then
		return null;
	end if;
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
	-- Owed time is paid first (normally already, when the hours arrived).
	perform public.qorpera_computer_hour_repay(new.profile_id, v_dry_run, new.metered_at, new.id);
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

-- Hours arriving (a plan period or credits, or a source unfrozen) pay what is owed at once: for a
-- credit the company's, for a plan period every company its holder is a founder of.
create function public.qorpera_computer_hour_hours_arrived()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_profile uuid;
begin
	if new.kind not in ('plan_period', 'credit') then
		return null;
	end if;
	if tg_op = 'UPDATE' and not (old.frozen_at is not null and new.frozen_at is null) then
		return null;
	end if;
	perform public.qorpera_computer_hour_lock_billing();
	for v_profile in
		select new.profile_id where new.kind = 'credit'
		union
		select member.profile_id from public.qorpera_profile_members member
		where new.kind = 'plan_period' and member.user_id = new.user_id and member.role = 'owner'
		order by 1
	loop
		if public.qorpera_computer_hour_complimentary_founder(v_profile) is null then
			perform public.qorpera_computer_hour_repay(v_profile, new.dry_run, clock_timestamp(), null);
		end if;
	end loop;
	return null;
end
$$;
revoke all on function public.qorpera_computer_hour_hours_arrived() from public, anon, authenticated, service_role;
create trigger qorpera_computer_hour_hours_arrived
	after insert or update of frozen_at on public.qorpera_computer_hour_sources
	for each row execute function public.qorpera_computer_hour_hours_arrived();

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
	v_now timestamptz := clock_timestamp();
	v_dry_run boolean;
	v_founders uuid[];
	v_left bigint;
begin
	if public.qorpera_computer_hour_complimentary_founder(p_profile_id) is not null then
		return null;
	end if;
	v_dry_run := public.qorpera_computer_hour_dry_run(v_now);
	v_founders := array(select founder.user_id from public.qorpera_company_founders(p_profile_id) founder);
	select
		-- Free hours not created yet are all still there.
		coalesce((select case when free.withdrawn_at is null and free.frozen_at is null
				then free.granted_seconds - free.drawn_seconds else 0 end
			from public.qorpera_computer_hour_sources free
			where free.kind = 'free' and free.profile_id = p_profile_id and free.dry_run = v_dry_run), 5 * 3600)
		+ coalesce((select sum(plan.granted_seconds - plan.drawn_seconds)
			from public.qorpera_computer_hour_sources plan
			where plan.kind = 'plan_period' and plan.dry_run = v_dry_run and plan.user_id = any(v_founders)
				and plan.withdrawn_at is null and plan.frozen_at is null
				and plan.period_start <= v_now and v_now < plan.period_end), 0)
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

-- For operators: the company's sources in the current mode. A plan period's figures are its
-- founder's whole plan, across every company it pays for.
create function public.qorpera_read_company_computer_hour_sources(p_profile_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_dry_run boolean := public.qorpera_computer_hour_dry_run(clock_timestamp());
	v_founders uuid[] := array(select founder.user_id from public.qorpera_company_founders(p_profile_id) founder);
begin
	return jsonb_build_object(
		'schema', 'qorpera.company-computer-hour-sources/v1',
		'profileId', p_profile_id,
		'mode', case when v_dry_run then 'dry_run' else 'live' end,
		'liveSince', (select billing.live_since from public.qorpera_computer_hour_billing billing),
		'hoursLeftSeconds', public.qorpera_company_computer_hours_left(p_profile_id),
		'sources', coalesce((
			select jsonb_agg(jsonb_build_object(
				'sourceId', source.id, 'kind', source.kind, 'userId', source.user_id,
				'grantedSeconds', source.granted_seconds, 'drawnSeconds', source.drawn_seconds,
				'repaidSeconds', source.repaid_seconds, 'periodStart', source.period_start,
				'periodEnd', source.period_end, 'expiresAt', source.expires_at,
				'withdrawnAt', source.withdrawn_at, 'frozenAt', source.frozen_at
			) order by source.created_at, source.id)
			from (
				select * from public.qorpera_computer_hour_sources
				where profile_id = p_profile_id and dry_run = v_dry_run
				union all
				select * from public.qorpera_computer_hour_sources
				where kind = 'plan_period' and user_id = any(v_founders) and dry_run = v_dry_run
			) source
		), '[]'::jsonb)
	);
end
$$;
revoke all on function public.qorpera_read_company_computer_hour_sources(uuid) from public, anon, authenticated;
grant execute on function public.qorpera_read_company_computer_hour_sources(uuid) to service_role;
