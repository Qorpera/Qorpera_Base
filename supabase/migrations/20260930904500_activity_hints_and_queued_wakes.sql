-- WHY: Emit Realtime 'activity' live hints on job/wake transitions and message_composition writes, and surface recently
-- queued wakes immediately in qorpera_list_staff_execution_activity before materialization creates a runner job.
set local lock_timeout = '3s';

do $$
begin
	if to_regprocedure('public.qorpera_list_staff_execution_activity(uuid)') is null
		or to_regprocedure('public.qorpera_live_hint_send(text,text[],text)') is null
		or to_regprocedure('public.qorpera_live_hint_profile_topics(uuid)') is null then
		raise exception '20260930904500 requires staff execution activity and live hints';
	end if;
	if position('20260930904500' in pg_get_functiondef(
		'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure)) > 0 then
		raise exception '20260930904500 is already applied';
	end if;
end $$;

-- WHY: Push one 'activity' hint per company per transaction under a 20 ms lock budget with every error absorbed.
create function public.qorpera_activity_hint()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_lock_timeout text := current_setting('lock_timeout');
	v_profile_id uuid;
	v_class text;
begin
	-- WHY: 20260930904500 marker for deploy guards; short-circuit once hinting failed in this transaction.
	if current_setting('qorpera.live_hints_failed', true) = 'on' then return null; end if;
	begin
		if tg_table_name = 'qorpera_runtime_observations' then
			select run.profile_id into v_profile_id
			from public.qorpera_execution_runs as run
			where run.id = new.run_id;
		else
			v_profile_id := new.profile_id;
		end if;
		if v_profile_id is null then return null; end if;
		v_class := v_profile_id || ' activity';
		if strpos(coalesce(current_setting('qorpera.live_hints_sent', true), ''), '|' || v_class || '|') > 0 then
			return null;
		end if;
		perform set_config('lock_timeout', '20ms', true);
		perform public.qorpera_live_hint_send('activity', public.qorpera_live_hint_profile_topics(v_profile_id), v_class);
		perform set_config('lock_timeout', v_lock_timeout, true);
	exception
		when query_canceled then
			perform set_config('qorpera.live_hints_failed', 'on', true);
		when others then
			perform set_config('qorpera.live_hints_failed', 'on', true);
	end;
	return null;
end $$;

revoke all on function public.qorpera_activity_hint()
	from public, anon, authenticated, service_role, qorpera_secret_broker;

create constraint trigger qorpera_activity_hint
	after insert on public.qorpera_runner_jobs
	deferrable initially deferred for each row
	execute function public.qorpera_activity_hint();

create constraint trigger qorpera_activity_hint_status
	after update of status on public.qorpera_runner_jobs
	deferrable initially deferred for each row
	when (new.status is distinct from old.status)
	execute function public.qorpera_activity_hint();

create constraint trigger qorpera_activity_hint
	after insert on public.qorpera_runtime_observations
	deferrable initially deferred for each row
	when (new.operation = 'message_composition')
	execute function public.qorpera_activity_hint();

-- WHY: Use non-deferred triggers on qorpera_wake_occurrences so same-transaction DDL never hits pending trigger events.
create trigger qorpera_activity_hint
	after insert on public.qorpera_wake_occurrences
	for each row
	when (new.status = 'queued' and new.source_kind <> 'surface-session')
	execute function public.qorpera_activity_hint();

create trigger qorpera_activity_hint_status
	after update of status on public.qorpera_wake_occurrences
	for each row
	when (old.status = 'queued' and new.status is distinct from 'queued'
		and new.status is distinct from 'materialized' and new.source_kind <> 'surface-session')
	execute function public.qorpera_activity_hint();

create function pg_temp.ahqw_patch(p_target regprocedure, p_pairs text[])
returns void
language plpgsql
as $$
declare
	v_def text := pg_get_functiondef(p_target);
	v_idx integer := 1;
	v_old text;
	v_new text;
begin
	while v_idx <= coalesce(array_length(p_pairs, 1), 0) loop
		v_old := p_pairs[v_idx];
		v_new := p_pairs[v_idx + 1];
		if v_old = '' or (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
			raise exception '20260930904500 anchor differs in %: %', p_target, left(v_old, 96);
		end if;
		v_def := replace(v_def, v_old, v_new);
		v_idx := v_idx + 2;
	end loop;
	execute v_def;
end $$;

select pg_temp.ahqw_patch(
	'public.qorpera_list_staff_execution_activity(uuid)'::regprocedure,
	array[
$old$				coalesce(job.finished_at, job.started_at, job.created_at) as updated_at,
				-- 20260930542000: a failure the agent's newer work superseded, with no decision of its own.
				job.status in ('failed', 'cancelled') and job.cancelled_by_user_id is null and not exists (
					select 1 from public.qorpera_company_proposals as proposal
					where proposal.execution_kind = 'run' and proposal.execution_id = run.id
						and proposal.status = 'open'
				) and exists (
					select 1 from public.qorpera_execution_runs as newer
					where newer.profile_id = run.profile_id and newer.environment_id = run.environment_id
						and newer.staff_agent_id = run.staff_agent_id and newer.id <> run.id
						and newer.created_at > coalesce(job.finished_at, job.started_at, job.created_at)
						and not (newer.source_kind = 'wake' and exists (
							select 1 from public.qorpera_wake_occurrences as newer_occ
							where newer_occ.id = newer.source_id and newer_occ.source_kind = 'surface-session'
						))
				) as superseded$old$,
$new$				coalesce(job.finished_at, job.started_at, job.created_at) as updated_at,
				false as is_queued_wake,
				-- 20260930542000: a failure the agent's newer work superseded, with no decision of its own.
				job.status in ('failed', 'cancelled') and job.cancelled_by_user_id is null and not exists (
					select 1 from public.qorpera_company_proposals as proposal
					where proposal.execution_kind = 'run' and proposal.execution_id = run.id
						and proposal.status = 'open'
				) and (exists (
					select 1 from public.qorpera_execution_runs as newer
					where newer.profile_id = run.profile_id and newer.environment_id = run.environment_id
						and newer.staff_agent_id = run.staff_agent_id and newer.id <> run.id
						and newer.created_at > coalesce(job.finished_at, job.started_at, job.created_at)
						and not (newer.source_kind = 'wake' and exists (
							select 1 from public.qorpera_wake_occurrences as newer_occ
							where newer_occ.id = newer.source_id and newer_occ.source_kind = 'surface-session'
						))
				) or exists (
					select 1 from public.qorpera_wake_occurrences as newer_wake
					where newer_wake.profile_id = v_profile_id and newer_wake.environment_id = run.environment_id
						and newer_wake.staff_agent_id = run.staff_agent_id
						and newer_wake.status = 'queued' and newer_wake.run_id is null
						and newer_wake.blocked_reason is null
						and newer_wake.wake_kind in ('room', 'agent', 'routine')
						and newer_wake.source_kind <> 'surface-session'
						and newer_wake.not_before <= clock_timestamp()
						and newer_wake.created_at >= clock_timestamp() - interval '5 minutes'
						and newer_wake.created_at > coalesce(job.finished_at, job.started_at, job.created_at)
						and not public.qorpera_company_execution_paused(v_profile_id)
						and not public.qorpera_company_at_zero(v_profile_id, clock_timestamp())
						and (newer_wake.sponsor_binding_id is null
							or not public.qorpera_sponsor_waits_for_usage_limit(
								newer_wake.sponsor_binding_id, newer_wake.sponsor_version))
				)) as superseded$new$,
$old$			)
		), current_activity as (
			select distinct on (staff_agent_id) *
			from candidates
			where not superseded
			order by staff_agent_id, priority desc, updated_at desc, run_id desc
		), earlier_failure as ($old$,
$new$			)
			union all
			-- WHY: 20260930904500 reflects recently queued wakes as waiting immediately before run materialization.
			select wake.id as run_id, wake.staff_agent_id,
				case when wake.wake_kind = 'room' then 'room_delivery' else 'wake' end as source_kind,
				'queued'::text as job_status,
				null::uuid as assignment_id, null::timestamptz as lease_expires_at, null::timestamptz as started_at,
				'waiting'::text as activity,
				1 as priority,
				wake.created_at as updated_at,
				true as is_queued_wake,
				false as superseded
			from public.qorpera_wake_occurrences as wake
			where wake.profile_id = v_profile_id and wake.environment_id = p_environment_id
				and wake.status = 'queued' and wake.run_id is null
				and wake.staff_agent_id is not null
				and wake.blocked_reason is null
				and wake.wake_kind in ('room', 'agent', 'routine')
				and wake.source_kind <> 'surface-session'
				and wake.not_before <= clock_timestamp()
				and wake.created_at >= clock_timestamp() - interval '5 minutes'
				and not public.qorpera_company_execution_paused(v_profile_id)
				and not public.qorpera_company_at_zero(v_profile_id, clock_timestamp())
				and (wake.sponsor_binding_id is null
					or not public.qorpera_sponsor_waits_for_usage_limit(wake.sponsor_binding_id, wake.sponsor_version))
		), current_activity as (
			select distinct on (staff_agent_id) *
			from candidates
			where not superseded
			order by staff_agent_id, priority desc, is_queued_wake asc, updated_at desc, run_id desc
		), earlier_failure as ($new$,
$old$		|| case when activity.job_status = 'queued' then public.qorpera_run_usage_pause_json(activity.run_id)$old$,
$new$		|| case when activity.job_status = 'queued' and not activity.is_queued_wake then public.qorpera_run_usage_pause_json(activity.run_id)$new$
	]
);

drop function pg_temp.ahqw_patch(regprocedure, text[]);

do $guard$
declare
	v_activity text := pg_get_functiondef('public.qorpera_list_staff_execution_activity(uuid)'::regprocedure);
	v_hint text := pg_get_functiondef('public.qorpera_activity_hint()'::regprocedure);
begin
	if strpos(v_activity, '20260930904500') = 0
		or strpos(v_activity, '20260930855000') = 0
		or strpos(v_activity, '20260930751000') = 0
		or strpos(v_activity, '20260930542000') = 0
		or strpos(v_activity, 'when job.cancelled_by_user_id is not null then 0') = 0 then
		raise exception '20260930904500 guard failed for qorpera_list_staff_execution_activity';
	end if;
	if strpos(v_hint, '20260930904500') = 0 then
		raise exception '20260930904500 guard failed for qorpera_activity_hint';
	end if;
end $guard$;
