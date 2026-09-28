-- Computer hours, build step 5: hour notices to founders, as an email outbox.
-- Contract: section 19, 2026-09-28 amendment "computer hours", items 10 (email) and 12 (order).
-- Design: deploy/first-node/RUNTIME-COMPUTER-HOURS.md ("Email").
--
-- Rules carried out here:
-- * Notices come only from live charges: before the live switch every charge is a dry run, so
--   nothing is queued (switched off until live payments). Complimentary companies get none.
-- * "Hours running low": once a month per company, when what is left is a fifth or less of the hours
--   in what pays now (the free hours while they last, the founders' current plan periods, the
--   company's credits in use), or under one hour. It goes to the founders whose plans pay (a current
--   plan period), the founders who bought the credits in use, or, while the company has neither,
--   every founder (it is on its free hours).
-- * "Out of hours": once per time the company runs out (it starts to owe time; hours arriving end
--   it), to every founder.
-- * A monthly summary: when a founder's plan period ends and the plan was used, one email to that
--   founder listing each company's use of it.
-- * Admins, contributors and viewers get no billing email: every recipient is a founder when the
--   notice is queued. The Edge Function computer-hour-notices sends through Resend, like invitations
--   (supabase/INVITATION-EMAIL.md); addresses are read when a notice is claimed.

set local lock_timeout = '10s';

create table public.qorpera_computer_hour_notices (
	id uuid primary key default extensions.gen_random_uuid(),
	kind text not null check (kind in ('running_low', 'out_of_hours', 'monthly_summary')),
	-- The company, for running low and out of hours; null for a summary (it lists companies).
	profile_id uuid,
	user_id uuid not null,
	-- One notice per recipient per occasion (a month, an episode of owing, a plan period).
	occasion text not null check (char_length(occasion) between 1 and 300),
	-- What the email says, fixed when queued (a company deleted later keeps its name here).
	details jsonb not null check (jsonb_typeof(details) = 'object'),
	status text not null default 'pending' check (status in ('pending', 'retrying', 'delivering', 'sent', 'failed')),
	attempt_count integer not null default 0 check (attempt_count >= 0),
	next_attempt_at timestamptz not null default clock_timestamp(),
	lease_id uuid,
	lease_expires_at timestamptz,
	provider_message_id text check (provider_message_id is null or char_length(provider_message_id) <= 256),
	last_error text check (last_error is null or char_length(last_error) <= 1000),
	created_at timestamptz not null default clock_timestamp(),
	sent_at timestamptz,
	unique (kind, user_id, occasion)
);
create index qorpera_computer_hour_notices_due on public.qorpera_computer_hour_notices (next_attempt_at)
	where status in ('pending', 'retrying', 'delivering');
alter table public.qorpera_computer_hour_notices enable row level security;
revoke all on public.qorpera_computer_hour_notices from public, anon, authenticated, service_role;
grant select on public.qorpera_computer_hour_notices to service_role;

-- "2026-09": the calendar month in Danish time, as the meter counts it.
create function public.qorpera_computer_hour_notice_month(p_at timestamptz)
returns text
language sql
immutable
set search_path = ''
as $$
	select to_char(p_at at time zone 'Europe/Copenhagen', 'YYYY-MM')
$$;
revoke all on function public.qorpera_computer_hour_notice_month(timestamptz) from public, anon, authenticated, service_role;

create function public.qorpera_computer_hour_queue_notice(
	p_kind text,
	p_profile_id uuid,
	p_user_ids uuid[],
	p_occasion text,
	p_details jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
	insert into public.qorpera_computer_hour_notices (kind, profile_id, user_id, occasion, details)
	select p_kind, p_profile_id, recipient.user_id, p_occasion, p_details
	from (select distinct unnest(p_user_ids) as user_id) recipient
	where recipient.user_id is not null
	on conflict (kind, user_id, occasion) do nothing
$$;
revoke all on function public.qorpera_computer_hour_queue_notice(text, uuid, uuid[], text, jsonb) from public, anon, authenticated, service_role;

-- After a live charge: is the company running low, or out? Runs after the charge trigger (trigger
-- names sort "charge" before "notice"), so the hours left already include this use.
create function public.qorpera_computer_hour_notice_usage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_month text;
	v_left bigint;
	v_hours bigint;
	v_founders uuid[];
	v_payers uuid[];
	v_owed public.qorpera_computer_hour_sources%rowtype;
	v_details jsonb;
begin
	if new.standard_seconds = 0 or public.qorpera_computer_hour_dry_run(new.metered_at) then
		return null;
	end if;
	-- Null: a complimentary company, which is never limited.
	v_left := public.qorpera_company_computer_hours_left(new.profile_id);
	if v_left is null then
		return null;
	end if;
	v_month := public.qorpera_computer_hour_notice_month(new.metered_at);
	v_founders := array(select founder.user_id from public.qorpera_company_founders(new.profile_id) founder);
	v_details := jsonb_build_object(
		'companyName', (select profile.name from public.qorpera_profiles profile where profile.id = new.profile_id),
		'leftSeconds', v_left, 'month', v_month);
	select * into v_owed from public.qorpera_computer_hour_sources owed
	where owed.kind = 'owed' and owed.profile_id = new.profile_id and not owed.dry_run;
	if v_owed.id is not null and v_owed.drawn_seconds > v_owed.repaid_seconds then
		-- One episode of owing lasts until hours arrive and repay it, which moves repaid_seconds.
		perform public.qorpera_computer_hour_queue_notice('out_of_hours', new.profile_id, v_founders,
			new.profile_id::text || ':' || v_owed.repaid_seconds::text, v_details);
		return null;
	end if;
	-- The hours in what pays now, the same sources hours-left reads (whole, not what is left of them).
	select
		coalesce((select case when free.withdrawn_at is null and free.frozen_at is null and free.drawn_seconds < free.granted_seconds
				then free.granted_seconds else 0 end
			from public.qorpera_computer_hour_sources free
			where free.kind = 'free' and free.profile_id = new.profile_id and not free.dry_run), 5 * 3600)
		+ coalesce((select sum(plan.granted_seconds) from public.qorpera_computer_hour_sources plan
			where plan.kind = 'plan_period' and not plan.dry_run and plan.user_id = any(v_founders)
				and plan.withdrawn_at is null and plan.frozen_at is null
				and plan.period_start <= new.metered_at and new.metered_at < plan.period_end), 0)
		+ coalesce((select sum(credit.granted_seconds) from public.qorpera_computer_hour_sources credit
			where credit.kind = 'credit' and not credit.dry_run and credit.profile_id = new.profile_id
				and credit.withdrawn_at is null and credit.frozen_at is null and credit.expires_at > new.metered_at), 0)
	into v_hours;
	if v_left >= 3600 and v_left * 5 > v_hours then
		return null;
	end if;
	-- Who pays now: founders with a current plan period, founders who bought credits still in use.
	v_payers := array(
		select plan.user_id from public.qorpera_computer_hour_sources plan
		where plan.kind = 'plan_period' and not plan.dry_run and plan.user_id = any(v_founders)
			and plan.withdrawn_at is null and plan.period_start <= new.metered_at and new.metered_at < plan.period_end
		union
		select credit.user_id from public.qorpera_computer_hour_sources credit
		where credit.kind = 'credit' and not credit.dry_run and credit.profile_id = new.profile_id
			and credit.withdrawn_at is null and credit.expires_at > new.metered_at
			and credit.drawn_seconds < credit.granted_seconds and credit.user_id = any(v_founders)
	);
	perform public.qorpera_computer_hour_queue_notice('running_low', new.profile_id,
		case when cardinality(v_payers) > 0 then v_payers else v_founders end,
		new.profile_id::text || ':' || v_month, v_details || jsonb_build_object('hoursSeconds', v_hours));
	return null;
end
$$;
revoke all on function public.qorpera_computer_hour_notice_usage() from public, anon, authenticated, service_role;
create trigger qorpera_computer_hour_notice_usage
	after insert on public.qorpera_computer_hour_usage
	for each row execute function public.qorpera_computer_hour_notice_usage();

-- Monthly summaries for plan periods that ended: one per founder whose plan was used, listing each
-- company's use (draws and repayments of owed time) across the period's sources (the period and
-- its upgrade top-up). Called by the worker before it claims.
create function public.qorpera_computer_hour_queue_summaries(p_now timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_period record;
	v_queued integer := 0;
	v_rows integer;
begin
	for v_period in
		select base.id, base.user_id, base.reference, base.period_start, base.period_end, base.granted_seconds
		from public.qorpera_computer_hour_sources base
		where base.kind = 'plan_period' and not base.dry_run and base.reference ~ '^sub_[A-Za-z0-9]+:[0-9]+$'
			and base.period_end <= p_now and base.period_end > p_now - interval '7 days'
			and not exists (
				select 1 from public.qorpera_computer_hour_notices notice
				where notice.kind = 'monthly_summary' and notice.user_id = base.user_id and notice.occasion = base.reference
			)
		order by base.period_end, base.id
		limit 200
	loop
		insert into public.qorpera_computer_hour_notices (kind, user_id, occasion, details)
		select 'monthly_summary', v_period.user_id, v_period.reference, jsonb_build_object(
			'periodStart', v_period.period_start, 'periodEnd', v_period.period_end,
			'grantedSeconds', v_period.granted_seconds + coalesce((select sum(top.granted_seconds)
				from public.qorpera_computer_hour_sources top
				where top.reference = v_period.reference || ':upgrade' and not top.dry_run), 0),
			'companies', used.companies)
		from (
			select jsonb_agg(jsonb_build_object('companyName', coalesce(profile.name, 'A deleted company'),
				'seconds', per_company.seconds) order by per_company.seconds desc) as companies
			from (
				select paid.profile_id, sum(paid.seconds)::bigint as seconds
				from (
					select usage.profile_id, draw.standard_seconds as seconds
					from public.qorpera_computer_hour_sources plan
					join public.qorpera_computer_hour_draws draw on draw.source_id = plan.id
					join public.qorpera_computer_hour_usage usage on usage.id = draw.usage_id
					where plan.id = v_period.id or (plan.reference = v_period.reference || ':upgrade' and not plan.dry_run)
					union all
					select owed.profile_id, repayment.standard_seconds
					from public.qorpera_computer_hour_sources plan
					join public.qorpera_computer_hour_repayments repayment on repayment.source_id = plan.id
					join public.qorpera_computer_hour_sources owed on owed.id = repayment.owed_source_id
					where plan.id = v_period.id or (plan.reference = v_period.reference || ':upgrade' and not plan.dry_run)
				) paid
				group by paid.profile_id
			) per_company
			left join public.qorpera_profiles profile on profile.id = per_company.profile_id
		) used
		-- A plan nobody used sends nothing.
		where used.companies is not null
		on conflict (kind, user_id, occasion) do nothing;
		get diagnostics v_rows = row_count;
		v_queued := v_queued + v_rows;
	end loop;
	return v_queued;
end
$$;
revoke all on function public.qorpera_computer_hour_queue_summaries(timestamptz) from public, anon, authenticated, service_role;

-- The worker's claim: queue due summaries, then lease up to p_limit notices for five minutes. A
-- recipient who is no longer a founder of the company (running low, out of hours) is skipped.
create function public.qorpera_claim_computer_hour_notices(p_limit integer, p_lease_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_result jsonb;
begin
	if p_limit not between 1 and 50 or p_lease_id is null then
		raise exception 'computer hour notice claim is invalid' using errcode = '22023';
	end if;
	perform public.qorpera_computer_hour_queue_summaries(clock_timestamp());
	update public.qorpera_computer_hour_notices notice
	set status = 'failed', last_error = 'The recipient is no longer a founder of the company', lease_id = null,
		lease_expires_at = null
	where (notice.status in ('pending', 'retrying') or (notice.status = 'delivering' and notice.lease_expires_at <= clock_timestamp()))
		and notice.profile_id is not null
		and not exists (
			select 1 from public.qorpera_company_founders(notice.profile_id) founder where founder.user_id = notice.user_id
		);
	update public.qorpera_computer_hour_notices notice
	set status = 'failed', last_error = 'The recipient has no email address', lease_id = null, lease_expires_at = null
	where (notice.status in ('pending', 'retrying') or (notice.status = 'delivering' and notice.lease_expires_at <= clock_timestamp()))
		and not exists (select 1 from auth.users recipient where recipient.id = notice.user_id and recipient.email is not null);
	with candidates as (
		select notice.id
		from public.qorpera_computer_hour_notices notice
		where notice.status in ('pending', 'retrying', 'delivering')
			and notice.next_attempt_at <= clock_timestamp()
			and (notice.lease_expires_at is null or notice.lease_expires_at <= clock_timestamp())
		order by notice.next_attempt_at, notice.created_at
		for update skip locked
		limit p_limit
	), claimed as (
		update public.qorpera_computer_hour_notices notice
		set status = 'delivering', attempt_count = notice.attempt_count + 1, lease_id = p_lease_id,
			lease_expires_at = clock_timestamp() + interval '5 minutes', last_error = null
		from candidates
		where notice.id = candidates.id
		returning notice.*
	)
	select coalesce(jsonb_agg(jsonb_build_object(
		'noticeId', claimed.id, 'kind', claimed.kind, 'recipientEmail', recipient.email,
		'details', claimed.details, 'attemptCount', claimed.attempt_count, 'leaseId', claimed.lease_id
	) order by claimed.created_at), '[]'::jsonb) into v_result
	from claimed
	join auth.users recipient on recipient.id = claimed.user_id;
	return v_result;
end
$$;

create function public.qorpera_complete_computer_hour_notice(p_notice_id uuid, p_lease_id uuid, p_provider_message_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_rows integer;
begin
	update public.qorpera_computer_hour_notices
	set status = 'sent', sent_at = clock_timestamp(), provider_message_id = left(p_provider_message_id, 256),
		lease_id = null, lease_expires_at = null, last_error = null
	where id = p_notice_id and lease_id = p_lease_id and status = 'delivering';
	get diagnostics v_rows = row_count;
	return v_rows = 1;
end
$$;

-- A retryable failure waits 1, 2, 4 ... minutes (at most an hour) and stops after eight attempts.
create function public.qorpera_fail_computer_hour_notice(p_notice_id uuid, p_lease_id uuid, p_error text, p_retryable boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_rows integer;
begin
	update public.qorpera_computer_hour_notices
	set status = case when p_retryable and attempt_count < 8 then 'retrying' else 'failed' end,
		next_attempt_at = clock_timestamp() + least(interval '1 hour', interval '1 minute' * power(2, greatest(attempt_count - 1, 0))),
		last_error = left(coalesce(p_error, 'Unknown error'), 1000), lease_id = null, lease_expires_at = null
	where id = p_notice_id and lease_id = p_lease_id and status = 'delivering';
	get diagnostics v_rows = row_count;
	return v_rows = 1;
end
$$;
revoke all on function public.qorpera_claim_computer_hour_notices(integer, uuid) from public, anon, authenticated;
revoke all on function public.qorpera_complete_computer_hour_notice(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.qorpera_fail_computer_hour_notice(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.qorpera_claim_computer_hour_notices(integer, uuid) to service_role;
grant execute on function public.qorpera_complete_computer_hour_notice(uuid, uuid, text) to service_role;
grant execute on function public.qorpera_fail_computer_hour_notice(uuid, uuid, text, boolean) to service_role;
