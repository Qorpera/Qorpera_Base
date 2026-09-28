-- Computer hours, build step 6a: at zero, new work waits (built switched off).
-- Contract: section 19, 2026-09-28 amendment "computer hours", item 7 ("At zero") and item 12.
-- Design: deploy/first-node/RUNTIME-COMPUTER-HOURS.md ("Zero").
--
-- A company at zero starts no new run: the check sits beside the company-paused check in each
-- function that creates runs, and the work stays queued, with no age limit, until hours arrive:
-- * wakes (routines, agents, rooms, workers, coding turns): the wake stays queued with the reason
--   "Waiting for computer hours";
-- * member messages, turn requests (hiring's first run included) and proposal reviews: they stay
--   queued, and members see why through `waitingForHours` in qorpera_read_company_computer_hours;
-- * the two direct enqueue calls (legacy clients, which cannot wait) are refused with that reason;
-- * a BEFORE INSERT backstop on qorpera_execution_runs raises if any other path creates one.
-- A run created before the company ran out is running work and is not touched here (the finishing
-- window is build step 6c). Machines not starting or waking at zero is build step 6b.
--
-- Switched off: `qorpera_computer_hour_billing.zero_rule_since` is null until the live switch
-- (build step 7) sets it together with live payments and hour notices.

set local lock_timeout = '10s';

alter table public.qorpera_computer_hour_billing add column zero_rule_since timestamptz;

-- At zero: the rule is on, the company is not complimentary and has no hours left. A founder's
-- subscription whose recorded period ended in the last 30 minutes counts as still paying: Stripe's
-- renewal invoice can trail the period's end by minutes, and work must not wait at every renewal.
create function public.qorpera_company_at_zero(p_profile_id uuid, p_at timestamptz)
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
	if v_since is null or p_at < v_since or p_profile_id is null then
		return false;
	end if;
	v_left := public.qorpera_company_computer_hours_left(p_profile_id);
	if v_left is null or v_left > 0 then
		return false;
	end if;
	return not exists (
		select 1 from public.qorpera_computer_hour_subscriptions subscription
		where subscription.livemode and subscription.status in ('active', 'past_due')
			and subscription.period_end <= p_at and subscription.period_end > p_at - interval '30 minutes'
			and subscription.user_id in (select founder.user_id from public.qorpera_company_founders(p_profile_id) founder)
	);
end
$$;
revoke all on function public.qorpera_company_at_zero(uuid, timestamptz) from public, anon, authenticated, service_role;

create function pg_temp.zero_wait_replace(p_definition text, p_old text, p_new text, p_what text)
returns text
language plpgsql
as $$
begin
	if (length(p_definition) - length(replace(p_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Zero rule: % anchor is not present exactly once', p_what;
	end if;
	return replace(p_definition, p_old, p_new);
end
$$;

-- Wakes: kept queued, with the reason.
do $patch$
declare v_definition text := pg_get_functiondef('public.qorpera_materialize_wake_execution_runs(integer)'::regprocedure);
begin
	v_definition := pg_temp.zero_wait_replace(v_definition, $old$				update public.qorpera_wake_occurrences set blocked_reason = 'Company execution is paused' where id = v_wake.id;
				continue;
			end if;$old$, $new$				update public.qorpera_wake_occurrences set blocked_reason = 'Company execution is paused' where id = v_wake.id;
				continue;
			end if;
			if public.qorpera_company_at_zero(v_wake.profile_id, v_now) then
				update public.qorpera_wake_occurrences set blocked_reason = 'Waiting for computer hours' where id = v_wake.id;
				continue;
			end if;$new$, 'wake materialization');
	execute v_definition;
end
$patch$;

-- Member messages: not picked, and not started if the company ran out meanwhile.
do $patch$
declare v_definition text := pg_get_functiondef('public.qorpera_materialize_session_execution_runs(integer)'::regprocedure);
begin
	v_definition := pg_temp.zero_wait_replace(v_definition, $old$			and not public.qorpera_company_execution_paused(session.profile_id)$old$,
		$new$			and not public.qorpera_company_execution_paused(session.profile_id)
			and not public.qorpera_company_at_zero(session.profile_id, clock_timestamp())$new$, 'session run filter');
	v_definition := pg_temp.zero_wait_replace(v_definition, $old$			or public.qorpera_company_execution_paused(v_session.profile_id) or exists ($old$,
		$new$			or public.qorpera_company_execution_paused(v_session.profile_id)
			or public.qorpera_company_at_zero(v_session.profile_id, clock_timestamp()) or exists ($new$, 'session run recheck');
	execute v_definition;
end
$patch$;

-- Turn requests (a member's turn on their own model account, hiring's first run).
do $patch$
declare v_definition text := pg_get_functiondef('public.qorpera_materialize_session_turn_requests(integer)'::regprocedure);
begin
	v_definition := pg_temp.zero_wait_replace(v_definition, $old$			and not public.qorpera_company_execution_paused(request.profile_id)$old$,
		$new$			and not public.qorpera_company_execution_paused(request.profile_id)
			and not public.qorpera_company_at_zero(request.profile_id, clock_timestamp())$new$, 'turn request filter');
	v_definition := pg_temp.zero_wait_replace(v_definition, $old$			or public.qorpera_company_execution_paused(v_session.profile_id) or exists ($old$,
		$new$			or public.qorpera_company_execution_paused(v_session.profile_id)
			or public.qorpera_company_at_zero(v_session.profile_id, clock_timestamp()) or exists ($new$, 'turn request recheck');
	execute v_definition;
end
$patch$;

-- Proposal reviews.
do $patch$
declare v_definition text := pg_get_functiondef('public.qorpera_materialize_company_proposal_review_runs(integer)'::regprocedure);
begin
	v_definition := pg_temp.zero_wait_replace(v_definition, $old$			and not public.qorpera_company_execution_paused(review.profile_id)$old$,
		$new$			and not public.qorpera_company_execution_paused(review.profile_id)
			and not public.qorpera_company_at_zero(review.profile_id, clock_timestamp())$new$, 'proposal review filter');
	v_definition := pg_temp.zero_wait_replace(v_definition, $old$		if public.qorpera_company_execution_paused(v_review.profile_id) then continue; end if;$old$,
		$new$		if public.qorpera_company_execution_paused(v_review.profile_id)
			or public.qorpera_company_at_zero(v_review.profile_id, clock_timestamp()) then continue; end if;$new$,
		'proposal review recheck');
	execute v_definition;
end
$patch$;

-- The direct enqueue calls cannot wait: refused with the reason.
do $patch$
declare v_definition text := pg_get_functiondef((select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
	where n.nspname = 'public' and p.proname = 'qorpera_enqueue_execution_run'));
begin
	v_definition := pg_temp.zero_wait_replace(v_definition, $old$		raise exception 'execution run requires company write access' using errcode = '42501';
	end if;$old$, $new$		raise exception 'execution run requires company write access' using errcode = '42501';
	end if;
	if public.qorpera_company_at_zero(v_environment.profile_id, clock_timestamp()) then
		raise exception 'Waiting for computer hours: the company has none left' using errcode = '55000';
	end if;$new$, 'direct execution run');
	execute v_definition;
end
$patch$;
do $patch$
declare v_definition text := pg_get_functiondef((select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
	where n.nspname = 'public' and p.proname = 'qorpera_enqueue_runner_job'));
begin
	v_definition := pg_temp.zero_wait_replace(v_definition, $old$		raise exception 'runner job creation requires write access' using errcode = '42501';
	end if;$old$, $new$		raise exception 'runner job creation requires write access' using errcode = '42501';
	end if;
	if public.qorpera_company_at_zero(v_profile_id, clock_timestamp()) then
		raise exception 'Waiting for computer hours: the company has none left' using errcode = '55000';
	end if;$new$, 'direct runner job');
	execute v_definition;
end
$patch$;

-- Backstop: every creator checks first, so this fires only on a path that does not.
create function public.qorpera_computer_hour_zero_run_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	if public.qorpera_company_at_zero(new.profile_id, clock_timestamp()) then
		raise exception 'Waiting for computer hours: no new run while the company has none left' using errcode = '55000';
	end if;
	return new;
end
$$;
revoke all on function public.qorpera_computer_hour_zero_run_guard() from public, anon, authenticated, service_role;
create trigger qorpera_computer_hour_zero_run_guard
	before insert on public.qorpera_execution_runs
	for each row execute function public.qorpera_computer_hour_zero_run_guard();

-- Members see that the company's work waits for computer hours.
do $patch$
declare v_definition text := pg_get_functiondef('public.qorpera_read_company_computer_hours(uuid,date)'::regprocedure);
begin
	v_definition := pg_temp.zero_wait_replace(v_definition,
		$old$		'meteredUntil', (select meter.metered_until from public.qorpera_computer_hour_meter meter)$old$,
		$new$		'meteredUntil', (select meter.metered_until from public.qorpera_computer_hour_meter meter),
		'waitingForHours', public.qorpera_company_at_zero(p_profile_id, clock_timestamp())$new$, 'member hours read');
	execute v_definition;
end
$patch$;
