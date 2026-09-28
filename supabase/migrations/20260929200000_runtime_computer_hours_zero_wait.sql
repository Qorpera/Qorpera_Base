-- Computer hours, build step 6a: at zero, new work waits (built switched off).
-- Contract: section 19, 2026-09-28 amendment "computer hours", item 7 ("At zero") and item 12.
-- Design: deploy/first-node/RUNTIME-COMPUTER-HOURS.md ("Zero").
--
-- A company at zero starts no new run: the check sits beside the company-paused check in each
-- function that creates runs, and the work stays queued, with no age limit, until hours arrive:
-- * wakes (agents, rooms, workers, coding turns): the wake stays queued with the reason "Waiting
--   for computer hours" (its visit moves it to the back of the queue, as a paused company's does);
-- * routines: the routine listing leaves the company's due routines out, and a slot asked for anyway
--   is deferred as while the company is paused (no wake is queued and the cursor stays, so the same
--   slot is offered again once hours arrive), so waiting work does not pile up;
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

-- At zero: the rule is on, payments are live (before the live switch every balance is a dry run
-- and nothing waits), the company is not complimentary and has no hours left. A founder's plan
-- period that ended in the last 30 minutes, with no next period recorded yet and its subscription
-- still active or past due, counts as still paying: Stripe's renewal invoice can trail the
-- period's end by minutes, and work must not wait at every renewal.
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
	if v_since is null or p_at < v_since or p_profile_id is null
		or public.qorpera_computer_hour_dry_run(p_at) then
		return false;
	end if;
	v_left := public.qorpera_company_computer_hours_left(p_profile_id);
	if v_left is null or v_left > 0 then
		return false;
	end if;
	return not exists (
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

-- Routines: a slot is deferred at zero, as while paused, so waiting wakes do not pile up.
do $patch$
declare v_definition text := pg_get_functiondef(
	'public.qorpera_enqueue_routine_wake(uuid,bigint,uuid,text,text,timestamptz,timestamptz,timestamptz,jsonb)'::regprocedure);
begin
	v_definition := pg_temp.zero_wait_replace(v_definition, $old$	if v_occurrence.id is null then
		insert into public.qorpera_wake_occurrences ($old$, $new$	if v_occurrence.id is null and public.qorpera_company_at_zero(v_routine.profile_id, clock_timestamp()) then
		return jsonb_build_object(
			'occurrence_id', null, 'status', 'deferred', 'run_id', null,
			'scheduled_for', p_scheduled_for, 'reason', 'Waiting for computer hours'
		);
	end if;
	if v_occurrence.id is null then
		insert into public.qorpera_wake_occurrences ($new$, 'routine slot');
	execute v_definition;
end
$patch$;

-- Routine listing: a company at zero has its due routines left out, so the orchestrator does not ask
-- about each deferred slot on every pass; they are listed again once hours arrive.
do $patch$
declare v_definition text := pg_get_functiondef('public.qorpera_list_routine_schedule_heads(uuid,integer)'::regprocedure);
begin
	v_definition := pg_temp.zero_wait_replace(v_definition, $old$		where routine.status = 'active'
			and (p_after_routine_id is null or routine.id > p_after_routine_id)$old$, $new$		where routine.status = 'active'
			and (p_after_routine_id is null or routine.id > p_after_routine_id)
			and not public.qorpera_company_at_zero(routine.profile_id, statement_timestamp())$new$, 'routine listing');
	v_definition := pg_temp.zero_wait_replace(v_definition, $old$		where routine.status = 'active' and v_next is not null and routine.id > v_next$old$,
		$new$		where routine.status = 'active' and v_next is not null and routine.id > v_next
			and not public.qorpera_company_at_zero(routine.profile_id, statement_timestamp())$new$, 'routine listing next page');
	execute v_definition;
end
$patch$;

-- The direct enqueue calls cannot wait: refused with the reason (after their idempotent replay, so a
-- retry of work made before zero still answers).
do $patch$
declare v_definition text := pg_get_functiondef(
	'public.qorpera_enqueue_execution_run(uuid,uuid,uuid,text,uuid,uuid,uuid,bigint,uuid,bigint,text,text,jsonb,text,text,uuid[],uuid)'::regprocedure);
begin
	v_definition := pg_temp.zero_wait_replace(v_definition, $old$		return public.qorpera_execution_run_json(v_run);
	end if;
	insert into public.qorpera_runner_jobs ($old$, $new$		return public.qorpera_execution_run_json(v_run);
	end if;
	if public.qorpera_company_at_zero(v_environment.profile_id, clock_timestamp()) then
		raise exception 'Waiting for computer hours: the company has none left' using errcode = '55000';
	end if;
	insert into public.qorpera_runner_jobs ($new$, 'direct execution run');
	execute v_definition;
end
$patch$;
do $patch$
declare v_definition text := pg_get_functiondef('public.qorpera_enqueue_runner_job(uuid,uuid,uuid,uuid,text,text,jsonb)'::regprocedure);
begin
	v_definition := pg_temp.zero_wait_replace(v_definition, $old$		return public.qorpera_runner_job_json(v_existing);
	end if;$old$, $new$		return public.qorpera_runner_job_json(v_existing);
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
