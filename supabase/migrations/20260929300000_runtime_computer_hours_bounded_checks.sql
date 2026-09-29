-- Computer hours: the zero rule's checks at a bounded cost (built switched off).
-- Contract: section 19, 2026-09-28 amendment "computer hours", item 7 ("At zero").
-- Design: deploy/first-node/RUNTIME-COMPUTER-HOURS.md ("Zero", "Before the live switch").
--
-- Once the rule is on, the checks ran the full at-zero check (the company's hours left, about
-- 0.4 ms) for every company on every call: every due routine on each orchestrator pass, every
-- company whose free hours are used up on each minute's sweep (a company that used its free hours
-- and never paid stays at zero for good), every job on each claim. Now:
-- * `qorpera_computer_hour_left_many(uuid[])` works out hours left for many companies in one query,
--   and `qorpera_company_computer_hours_left(uuid)` is that for one company: one definition.
-- * `qorpera_company_at_zero(profile, at)` first looks the company up in the zero state the sweep
--   keeps (build step 6c part 1): a company not recorded there is not at zero, at the cost of one
--   key lookup. The full check (`qorpera_company_at_zero_now`) runs only for a recorded company,
--   so leaving zero (hours arriving, a renewal) still counts at once. Running out counts from the
--   next sweep, up to a minute later, which is how often the meter charges use anyway.
-- * The sweep works out hours left for its companies in one query and runs the full check only
--   for a company with none left: a newly recorded company, and a recorded one near a founder's
--   period end (the renewal grace); a recorded company with hours left, or complimentary, is
--   removed without it.
-- * The routine listing leaves out a company recorded in the zero state, with no full check (a
--   routine waits at most one sweep longer once hours arrive).

set local lock_timeout = '3s';

create function public.qorpera_computer_hour_left_many(p_profile_ids uuid[])
returns table (profile_id uuid, left_seconds bigint)
language sql
stable
security definer
set search_path = ''
as $$
	-- One clock read, materialised once (clock_timestamp() is volatile): every company is read at
	-- the same moment. Each term is one grouped join, so the cost grows with the companies and their
	-- sources, not with their square.
	with moment as (
		select clock.now, public.qorpera_computer_hour_dry_run(clock.now) as dry_run
		from (select clock_timestamp() as now) clock
	),
	companies as (
		select distinct requested.profile_id from unnest(p_profile_ids) as requested(profile_id)
		where requested.profile_id is not null
	),
	founders as (
		select distinct company.profile_id, founder.user_id
		from companies company
		cross join lateral public.qorpera_company_founders(company.profile_id) founder
	),
	complimentary as (
		select distinct founder.profile_id
		from founders founder
		join public.qorpera_account_entitlements entitlement
			on entitlement.user_id = founder.user_id and entitlement.plan_key = 'internal'
	),
	free as (
		select free.profile_id, case when free.withdrawn_at is null and free.frozen_at is null
			then free.granted_seconds - free.drawn_seconds else 0 end as seconds
		from companies company
		join public.qorpera_computer_hour_sources free on free.profile_id = company.profile_id and free.kind = 'free'
		cross join moment
		where free.dry_run = moment.dry_run
	),
	plans as (
		select founder.profile_id, sum(plan.granted_seconds - plan.drawn_seconds) as seconds
		from founders founder
		join public.qorpera_computer_hour_sources plan on plan.user_id = founder.user_id and plan.kind = 'plan_period'
		cross join moment
		where plan.dry_run = moment.dry_run and plan.withdrawn_at is null and plan.frozen_at is null
			and plan.period_start <= moment.now and moment.now < plan.period_end
		group by founder.profile_id
	),
	credits as (
		select credit.profile_id, sum(credit.granted_seconds - credit.drawn_seconds) as seconds
		from companies company
		join public.qorpera_computer_hour_sources credit on credit.profile_id = company.profile_id and credit.kind = 'credit'
		cross join moment
		where credit.dry_run = moment.dry_run and credit.withdrawn_at is null and credit.frozen_at is null
			and credit.expires_at > moment.now
		group by credit.profile_id
	),
	owed as (
		select owed.profile_id, owed.drawn_seconds - owed.repaid_seconds as seconds
		from companies company
		join public.qorpera_computer_hour_sources owed on owed.profile_id = company.profile_id and owed.kind = 'owed'
		cross join moment
		where owed.dry_run = moment.dry_run
	)
	select company.profile_id,
		case when complimentary.profile_id is not null then null
		-- Free hours not created yet are all still there.
		else coalesce(free.seconds, 5 * 3600) + coalesce(plans.seconds, 0) + coalesce(credits.seconds, 0)
			- coalesce(owed.seconds, 0) end
	from companies company
	left join complimentary on complimentary.profile_id = company.profile_id
	left join free on free.profile_id = company.profile_id
	left join plans on plans.profile_id = company.profile_id
	left join credits on credits.profile_id = company.profile_id
	left join owed on owed.profile_id = company.profile_id
$$;
revoke all on function public.qorpera_computer_hour_left_many(uuid[]) from public, anon, authenticated, service_role;

-- One company: the same computation, so the two can never drift apart.
create or replace function public.qorpera_company_computer_hours_left(p_profile_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
	select hours.left_seconds from public.qorpera_computer_hour_left_many(array[p_profile_id]) hours
$$;

-- The full check, as build step 6a wrote it: for the sweep, and for a company recorded at zero.
create function public.qorpera_company_at_zero_now(p_profile_id uuid, p_at timestamptz)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
	v_since timestamptz := (select billing.zero_rule_since from public.qorpera_computer_hour_billing billing);
	v_left bigint;
begin
	if v_since is null or p_at < v_since or p_profile_id is null
		or public.qorpera_computer_hour_dry_run(p_at) then
		return false;
	end if;
	v_left := public.qorpera_company_computer_hours_left(p_profile_id);
	if v_left is null or v_left > 0 then
		return false;
	end if;
	return not public.qorpera_computer_hour_renewal_grace(p_profile_id, p_at);
end
$$;
revoke all on function public.qorpera_company_at_zero_now(uuid, timestamptz) from public, anon, authenticated, service_role;

-- A founder's plan period that ended in the last 30 minutes, with no next period recorded yet and
-- its subscription still active or past due: still paying (Stripe's renewal invoice can trail the
-- period's end by minutes).
create function public.qorpera_computer_hour_renewal_grace(p_profile_id uuid, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1
		from public.qorpera_computer_hour_sources plan
		join public.qorpera_computer_hour_subscriptions subscription
			on subscription.stripe_subscription_id = split_part(plan.reference, ':', 1)
		where plan.kind = 'plan_period' and not plan.dry_run and plan.withdrawn_at is null
			and plan.reference ~ '^sub_[A-Za-z0-9]+:[0-9]+$'
			and plan.user_id in (select founder.user_id from public.qorpera_company_founders(p_profile_id) founder)
			and plan.period_end <= p_at and plan.period_end > p_at - interval '30 minutes'
			and subscription.livemode and subscription.status in ('active', 'past_due')
			and not exists (
				select 1 from public.qorpera_computer_hour_sources later
				where later.user_id = plan.user_id and later.kind = 'plan_period' and not later.dry_run
					and later.reference ~ '^sub_[A-Za-z0-9]+:[0-9]+$'
					and split_part(later.reference, ':', 1) = split_part(plan.reference, ':', 1)
					and later.period_start >= plan.period_end
			)
	)
$$;
revoke all on function public.qorpera_computer_hour_renewal_grace(uuid, timestamptz)
	from public, anon, authenticated, service_role;

-- Every hook of the rule asks this: one key lookup for a company not recorded at zero.
create or replace function public.qorpera_company_at_zero(p_profile_id uuid, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1 from public.qorpera_computer_hour_zero_state zero where zero.profile_id = p_profile_id
	) and public.qorpera_company_at_zero_now(p_profile_id, p_at)
$$;

-- The sweep: hours left for its companies in one query, the full check only with none left.
create or replace function public.qorpera_computer_hour_zero_sweep(p_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
	v_since timestamptz := (select billing.zero_rule_since from public.qorpera_computer_hour_billing billing);
	v_cleared integer;
	v_ran_out integer := 0;
	v_profile uuid;
begin
	if not pg_try_advisory_xact_lock(hashtextextended('qorpera.computer-hour-meter', 0)) then
		return jsonb_build_object('skipped', true);
	end if;
	if v_since is null or p_at < v_since or public.qorpera_computer_hour_dry_run(p_at) then
		delete from public.qorpera_computer_hour_zero_state;
		get diagnostics v_cleared = row_count;
		return jsonb_build_object('cleared', v_cleared, 'ranOut', 0);
	end if;
	-- Recorded companies with hours left (or complimentary) leave at once; one with none left is
	-- checked in full only near a founder's period end, when the renewal grace may hold.
	delete from public.qorpera_computer_hour_zero_state zero
	using public.qorpera_computer_hour_left_many(array(select recorded.profile_id
		from public.qorpera_computer_hour_zero_state recorded)) hours
	where hours.profile_id = zero.profile_id
		and (hours.left_seconds is null or hours.left_seconds > 0
			or (exists (
				select 1 from public.qorpera_computer_hour_sources plan
				where plan.kind = 'plan_period' and not plan.dry_run
					and plan.period_end <= p_at and plan.period_end > p_at - interval '30 minutes'
					and plan.user_id in (select founder.user_id from public.qorpera_company_founders(zero.profile_id) founder)
			) and not public.qorpera_company_at_zero_now(zero.profile_id, p_at)));
	get diagnostics v_cleared = row_count;
	-- Only a company whose live free hours are used up can be at zero; of those, only one with no
	-- hours left is checked in full.
	for v_profile in
		select hours.profile_id
		from public.qorpera_computer_hour_left_many(array(
			select free.profile_id
			from public.qorpera_computer_hour_sources free
			join public.qorpera_profiles profile on profile.id = free.profile_id
			where free.kind = 'free' and not free.dry_run
				and (free.drawn_seconds >= free.granted_seconds or free.withdrawn_at is not null or free.frozen_at is not null)
				and not exists (
					select 1 from public.qorpera_computer_hour_zero_state zero where zero.profile_id = free.profile_id
				)
				and not public.qorpera_company_deleting(free.profile_id)
		)) hours
		where hours.left_seconds <= 0
		order by hours.profile_id
	loop
		continue when not public.qorpera_company_at_zero_now(v_profile, p_at);
		insert into public.qorpera_computer_hour_zero_state (profile_id, ran_out_at) values (v_profile, p_at);
		v_ran_out := v_ran_out + 1;
		perform public.qorpera_computer_hour_queue_notice('out_of_hours', v_profile,
			array(select founder.user_id from public.qorpera_company_founders(v_profile) founder),
			public.qorpera_computer_hour_zero_occasion(v_profile, p_at),
			jsonb_build_object(
				'companyName', (select profile.name from public.qorpera_profiles profile where profile.id = v_profile),
				'leftSeconds', least(coalesce(public.qorpera_company_computer_hours_left(v_profile), 0), 0),
				'month', public.qorpera_computer_hour_notice_month(p_at)),
			clock_timestamp() + interval '10 minutes');
	end loop;
	return jsonb_build_object('cleared', v_cleared, 'ranOut', v_ran_out);
end
$$;

create function pg_temp.bounded_checks_replace(p_definition text, p_old text, p_new text, p_what text)
returns text
language plpgsql
as $$
begin
	if (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Bounded checks: % anchor is not present exactly once', p_what;
	end if;
	return replace(p_definition, p_old, p_new);
end
$$;

-- The routine listing: the zero state only (no full check per due routine on every pass).
do $patch$
declare v_definition text := pg_get_functiondef('public.qorpera_list_routine_schedule_heads(uuid,integer)'::regprocedure);
begin
	v_definition := pg_temp.bounded_checks_replace(v_definition, $old$			and (p_after_routine_id is null or routine.id > p_after_routine_id)
			and not public.qorpera_company_at_zero(routine.profile_id, statement_timestamp())$old$,
		$new$			and (p_after_routine_id is null or routine.id > p_after_routine_id)
			and not exists (select 1 from public.qorpera_computer_hour_zero_state as zero
				where zero.profile_id = routine.profile_id)$new$, 'routine listing');
	v_definition := pg_temp.bounded_checks_replace(v_definition, $old$		where routine.status = 'active' and v_next is not null and routine.id > v_next
			and not public.qorpera_company_at_zero(routine.profile_id, statement_timestamp())$old$,
		$new$		where routine.status = 'active' and v_next is not null and routine.id > v_next
			and not exists (select 1 from public.qorpera_computer_hour_zero_state as zero
				where zero.profile_id = routine.profile_id)$new$, 'routine listing next page');
	execute v_definition;
end
$patch$;
