-- No run, machine or API-key caps (Jonas, 2026-09-24), after the company
-- execution ceilings went in 20260924080000:
--
-- * No per-company running-machine limit. A company starts as many computers
--   as the nodes have room for; the node chooser and node capacity stay the
--   only bound. The limit table, its member RPCs and its refusal notices go.
-- * No monthly budget and no per-run call, token or cost cap on API-key
--   connections. A connection keeps its own concurrency (like the 64 of a
--   subscription account), now counted over every run it still holds rather
--   than only this month's.
-- * No run deadline. OpenAI, Anthropic and xAI publish no cap on how long one
--   agent run may take, so neither does Qorpera: a run's deadline is set a
--   century out, and neither a run nor its native connection lease is bounded
--   by 24 hours any more. Crash detection (job and connection leases that
--   lapse when not renewed) is unchanged, and so is the power-off of idle
--   company computers.

create function pg_temp.cap_patch(p_target regprocedure, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text := pg_get_functiondef(p_target);
begin
	if (length(v_definition) - length(replace(v_definition, p_old, ''))) / length(p_old) <> 1 then
		raise exception 'Cap removal differs: % near %', p_target, left(p_old, 60); end if;
	execute replace(v_definition, p_old, p_new);
end
$$;

-- ---------------------------------------------------------------------------
-- No company machine limit
-- ---------------------------------------------------------------------------
select pg_temp.cap_patch('public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)'::regprocedure,
	$old$	else
		select coalesce((select max_machines from public.qorpera_company_machine_limits where profile_id=v_profile),8) into v_limit;
		select count(*) into v_count from public.qorpera_runtime_machine_allocations where profile_id=v_profile and released_at is null;
		if v_count>=v_limit then
			-- This committed refusal is distinct from an ambiguous transport failure.
			insert into public.qorpera_runtime_machine_refusals(allocation_id,profile_id,used,ceiling)
			values(p_allocation_id,v_profile,v_count,v_limit) on conflict(allocation_id) do nothing;
			if found then
				insert into public.qorpera_member_notifications(profile_id,user_id,kind,subject,dedupe_key)
				select v_profile,user_id,'company_ceiling_tripped',jsonb_build_object('schema','qorpera.member-notification.machine-capacity/v1',
					'dimension','machines','used',v_count,'ceiling',v_limit,'allocationId',p_allocation_id),'machines:'||p_allocation_id::text
				from public.qorpera_profile_members where profile_id=v_profile and role in ('owner','admin')
				on conflict(profile_id,user_id,kind,dedupe_key) where acknowledged_at is null do nothing;
			end if;
			return jsonb_build_object('state','refused','reason','MACHINE_CAPACITY_EXHAUSTED');
		end if;
$old$,
	$new$	else
$new$);
select pg_temp.cap_patch('public.qorpera_reserve_runtime_machine(uuid,text,text,uuid,uuid,uuid,bigint)'::regprocedure,
	$old$	v_profile uuid; v_job_id uuid; v_limit integer; v_count bigint;$old$,
	$new$	v_profile uuid; v_job_id uuid;$new$);

select pg_temp.cap_patch('public.qorpera_reserve_runtime_login_machine(uuid,text,text,uuid,text)'::regprocedure,
	$old$
 elsif v_allocation.id is null then
  select coalesce((select max_machines from public.qorpera_company_machine_limits where profile_id=v_login.profile_id),8) into v_limit;
  select count(*) into v_count from public.qorpera_runtime_machine_allocations where profile_id=v_login.profile_id and released_at is null;
  if v_count>=v_limit then v_reason:='MACHINE_CAPACITY_EXHAUSTED'; end if;
 end if;$old$,
	$new$
 end if;$new$);
select pg_temp.cap_patch('public.qorpera_reserve_runtime_login_machine(uuid,text,text,uuid,text)'::regprocedure,
	$old$ v_role text; v_limit integer; v_count bigint; v_reason text;$old$,
	$new$ v_role text; v_reason text;$new$);

select pg_temp.cap_patch('public.qorpera_reserve_runtime_account_refresh_machine(uuid,text,text,uuid,text)'::regprocedure,
	$old$
 elsif v_allocation.id is null then
  select coalesce((select max_machines from public.qorpera_company_machine_limits where profile_id=v_login.profile_id),8) into v_limit;
  select count(*) into v_count from public.qorpera_runtime_machine_allocations where profile_id=v_login.profile_id and released_at is null;
  if v_count>=v_limit then v_reason:='MACHINE_CAPACITY_EXHAUSTED'; end if;
 end if;$old$,
	$new$
 end if;$new$);
select pg_temp.cap_patch('public.qorpera_reserve_runtime_account_refresh_machine(uuid,text,text,uuid,text)'::regprocedure,
	$old$ v_role text; v_limit integer; v_count bigint; v_reason text;$old$,
	$new$ v_role text; v_reason text;$new$);

select pg_temp.cap_patch('public.qorpera_authorize_coding_machine(uuid,uuid,text,text,text)'::regprocedure,
	$old$		select coalesce((select max_machines from public.qorpera_company_machine_limits where profile_id = v_worker.profile_id), 8) into v_ceiling;
		select count(*) into v_occupied from public.qorpera_runtime_machine_allocations where profile_id = v_worker.profile_id and released_at is null;
		if v_occupied >= v_ceiling then
			insert into public.qorpera_runtime_machine_refusals(allocation_id, profile_id, used, ceiling)
			values (v_allocation_id, v_worker.profile_id, v_occupied, v_ceiling) on conflict (allocation_id) do nothing;
			if found then
				insert into public.qorpera_member_notifications(profile_id, user_id, kind, subject, dedupe_key)
				select v_worker.profile_id, user_id, 'company_ceiling_tripped', jsonb_build_object('schema','qorpera.member-notification.machine-capacity/v1',
					'dimension','machines','used',v_occupied,'ceiling',v_ceiling,'allocationId',v_allocation_id), 'machines:' || v_allocation_id::text
				from public.qorpera_profile_members where profile_id = v_worker.profile_id and role in ('owner','admin')
				on conflict (profile_id, user_id, kind, dedupe_key) where acknowledged_at is null do nothing;
			end if;
			return '{"state":"refused","reason":"MACHINE_CAPACITY_EXHAUSTED"}'::jsonb;
		end if;
$old$,
	'');
select pg_temp.cap_patch('public.qorpera_authorize_coding_machine(uuid,uuid,text,text,text)'::regprocedure,
	$old$ v_node jsonb; v_ceiling integer; v_occupied bigint;$old$,
	$new$ v_node jsonb;$new$);

drop function public.qorpera_set_company_machine_limit(uuid,integer,bigint);
drop function public.qorpera_company_machine_capacity(uuid);
drop table public.qorpera_company_machine_limits;

-- The machine-capacity notice was the last use of company_ceiling_tripped.
delete from public.qorpera_member_notifications where kind = 'company_ceiling_tripped';
alter table public.qorpera_member_notifications drop constraint qorpera_member_notifications_kind;
alter table public.qorpera_member_notifications add constraint qorpera_member_notifications_kind
	check (kind in ('provider_usage_limit','sponsor_handoff','routine_needs_model_account','routine_suspended'));

-- ---------------------------------------------------------------------------
-- No API-key budget or per-run caps; a connection keeps its concurrency
-- ---------------------------------------------------------------------------
select pg_temp.cap_patch('public.qorpera_reserve_execution_sponsor_authority(uuid)'::regprocedure,
	$old$	select count(*) filter (where reservation.status = 'reserved'),
		coalesce(sum(reservation.reserved_microusd) filter (where reservation.status = 'reserved'), 0),
		coalesce(sum(reservation.actual_microusd) filter (where reservation.status = 'settled'), 0)
	into v_active, v_reserved_total, v_actual_total
	from public.qorpera_execution_sponsor_reservations as reservation
	where reservation.provider_connection_id = v_connection.id
		and reservation.period_start = v_period_start;
	if v_active >= v_max_concurrent or (v_connection_version.authentication_mode <> 'native_subscription'
  and v_reserved_total + v_actual_total + v_reservation > v_monthly) then
		return false;
	end if;$old$,
	$new$	-- Concurrency is the only bound a connection keeps: every run it still
	-- holds counts, whichever month reserved it.
	select count(*) into v_active
	from public.qorpera_execution_sponsor_reservations as reservation
	where reservation.provider_connection_id = v_connection.id and reservation.status = 'reserved';
	if v_active >= v_max_concurrent then
		return false;
	end if;$new$);
select pg_temp.cap_patch('public.qorpera_reserve_execution_sponsor_authority(uuid)'::regprocedure,
	$old$	v_monthly := (v_connection_version.quota_policy ->> 'monthly_microusd')::bigint;
$old$,
	'');
select pg_temp.cap_patch('public.qorpera_reserve_execution_sponsor_authority(uuid)'::regprocedure,
	$old$	v_monthly bigint;
$old$,
	'');
select pg_temp.cap_patch('public.qorpera_reserve_execution_sponsor_authority(uuid)'::regprocedure,
	$old$	v_reserved_total bigint;
	v_actual_total bigint;
$old$,
	'');

-- The model gateway (API-key runs only) meters cost and tokens but no longer
-- refuses a call or ends a run over a per-run budget.
select pg_temp.cap_patch('public.qorpera_runner_model_gateway_authority(uuid)'::regprocedure,
	$old$		'max_cost_microusd', least(policy.max_cost_microusd, reservation.reserved_microusd)
			- coalesce((
				select sum(observation.cost_microusd)
				from public.qorpera_runner_model_usage_observations as observation
				where observation.job_id = run.job_id
			), 0)$old$,
	$new$		'max_cost_microusd', 9007199254740991::bigint$new$);

select pg_temp.cap_patch('public.qorpera_runner_broker_reserve_model_request(uuid,text,uuid,text,uuid,text,text,text,bigint,bigint)'::regprocedure,
	$old$	if v_calls >= v_policy.max_calls
		or v_input_tokens + p_input_token_reservation > v_policy.max_input_tokens
		or v_output_tokens + p_output_token_reservation > v_policy.max_output_tokens
		or (v_job.run_id is not null and exists ($old$,
	$new$	if (v_job.run_id is not null and exists ($new$);

select pg_temp.cap_patch('public.qorpera_runner_broker_finalize_model_request(uuid,text,uuid,text,uuid,text,text,bigint,bigint,bigint,jsonb,text)'::regprocedure,
	$old$		v_budget_exceeded := v_cost_used + p_cost_microusd
			> least(v_policy.max_cost_microusd, v_reservation.reserved_microusd);$old$,
	$new$		v_budget_exceeded := false;$new$);

-- ---------------------------------------------------------------------------
-- No run deadline
-- ---------------------------------------------------------------------------
alter table public.qorpera_execution_runs alter column deadline_at set default statement_timestamp() + interval '100 years';
alter table public.qorpera_execution_runs drop constraint qorpera_execution_runs_check2;
alter table public.qorpera_execution_runs add constraint qorpera_execution_runs_check2 check (deadline_at > created_at);
-- A cut applies this with the runtime quiet (no queued or leased work), so no
-- open run keeps an old 24 h deadline; every run materialized after it gets
-- the new default.

alter table public.qorpera_native_provider_connection_leases drop constraint qorpera_native_provider_connection_leases_check;
alter table public.qorpera_native_provider_connection_leases add constraint qorpera_native_provider_connection_leases_check
	check (expires_at > created_at);

-- A completed run may have taken any time: usage records it in bigint
-- milliseconds, and a run with no wall time reports 9007199254740991 as its
-- limit (the runtime's "none").
alter table public.qorpera_runner_usage_observations
	alter column execution_ms type bigint, alter column wall_time_limit_ms type bigint;
select pg_temp.cap_patch('public.qorpera_complete_runner_job_v3(uuid,text,uuid,text,uuid,uuid,jsonb)'::regprocedure,
	$old$		or (v_usage ->> 'execution_ms')::numeric not between 1 and 86400000$old$,
	$new$		or (v_usage ->> 'execution_ms')::numeric not between 1 and 9007199254740991$new$);
select pg_temp.cap_patch('public.qorpera_complete_runner_job_v3(uuid,text,uuid,text,uuid,uuid,jsonb)'::regprocedure,
	$old$		or (v_limits ->> 'wall_time_ms')::numeric not between 10 and 86400000$old$,
	$new$		or (v_limits ->> 'wall_time_ms')::numeric not between 10 and 9007199254740991$new$);
select pg_temp.cap_patch('public.qorpera_complete_runner_job_v3(uuid,text,uuid,text,uuid,uuid,jsonb)'::regprocedure,
	$old$	v_execution_ms := (v_usage ->> 'execution_ms')::integer;$old$,
	$new$	v_execution_ms := (v_usage ->> 'execution_ms')::bigint;$new$);
select pg_temp.cap_patch('public.qorpera_complete_runner_job_v3(uuid,text,uuid,text,uuid,uuid,jsonb)'::regprocedure,
	$old$	v_wall_time_limit_ms := (v_limits ->> 'wall_time_ms')::integer;$old$,
	$new$	v_wall_time_limit_ms := (v_limits ->> 'wall_time_ms')::bigint;$new$);
select pg_temp.cap_patch('public.qorpera_complete_runner_job_v3(uuid,text,uuid,text,uuid,uuid,jsonb)'::regprocedure,
	$old$	v_execution_ms integer;$old$,
	$new$	v_execution_ms bigint;$new$);
select pg_temp.cap_patch('public.qorpera_complete_runner_job_v3(uuid,text,uuid,text,uuid,uuid,jsonb)'::regprocedure,
	$old$	v_wall_time_limit_ms integer;$old$,
	$new$	v_wall_time_limit_ms bigint;$new$);
alter table public.qorpera_runner_usage_observations drop constraint qorpera_runner_usage_observations_execution_ms_check;
alter table public.qorpera_runner_usage_observations add constraint qorpera_runner_usage_observations_execution_ms_check
	check (execution_ms >= 1);
alter table public.qorpera_runner_usage_observations drop constraint qorpera_runner_usage_observations_wall_time_limit_ms_check;
alter table public.qorpera_runner_usage_observations add constraint qorpera_runner_usage_observations_wall_time_limit_ms_check
	check (wall_time_limit_ms >= 10);

-- ---------------------------------------------------------------------------
-- No cap on a run's tools, calls or turns
-- ---------------------------------------------------------------------------
-- Jonas: "we obviously shouldn't cap a run's tool calls, not through the
-- database, agent machines or the guests... if the model-providers themselves
-- have gates, they will enforce them for us."
-- * A native run starts with every tool its agent is granted: the kernel
--   refused more than 32 (the guest more than 48). The catalog's shape is still
--   checked, and its text is bounded at 1 MiB as storage for the start record.
select pg_temp.cap_patch('public.qorpera_begin_native_company_execution_v2(jsonb,text,text,text,text,text,integer)'::regprocedure,
	$old$	if jsonb_array_length(v_catalog -> 'tools') not between 1 and 32$old$,
	$new$	if jsonb_array_length(v_catalog -> 'tools') < 1$new$);
-- * A worker (coding session or in-house) takes any number of follow-up turns
--   (was 64 and 12), and an agent may dispatch or follow up workers without an
--   hourly limit (was 24 an hour). At most four workers run for one agent at
--   once; that bounds parallel work, not how much work is done.
alter table public.qorpera_runtime_workers drop constraint qorpera_runtime_workers_sequence_check;
alter table public.qorpera_runtime_workers add constraint qorpera_runtime_workers_sequence_check check (sequence >= 1);
select pg_temp.cap_patch('public.qorpera_manage_agent_worker(jsonb,jsonb)'::regprocedure,
	$old$		if (select count(*) from public.qorpera_runtime_worker_events event join public.qorpera_runtime_workers worker on worker.id = event.worker_id
			where worker.profile_id = v_run.profile_id and worker.staff_agent_id = v_run.staff_agent_id
				and event.kind in ('dispatched','followup') and event.created_at > clock_timestamp() - interval '1 hour') >= 24 then
			raise exception 'Worker dispatch limit for this hour is reached' using errcode = '54000'; end if;
$old$,
	'');
select pg_temp.cap_patch('public.qorpera_manage_agent_worker(jsonb,jsonb)'::regprocedure,
	$old$		if (v_worker.species = 'in-house' and (v_worker.state = 'cancelled' or v_worker.sequence >= 12))
			or (v_worker.species = 'coding' and v_worker.sequence >= 64) then$old$,
	$new$		if v_worker.species = 'in-house' and v_worker.state = 'cancelled' then$new$);
select pg_temp.cap_patch('public.qorpera_answer_coding_session(uuid,text,uuid)'::regprocedure,
	$old$	if v_worker.sequence >= 64 then raise exception 'This session cannot continue; start a new one' using errcode = '55000'; end if;
$old$,
	'');
select pg_temp.cap_patch('public.qorpera_begin_native_company_execution_v2(jsonb,text,text,text,text,text,integer)'::regprocedure,
	$old$	if p_tool_catalog_text is null or octet_length(p_tool_catalog_text) not between 1 and 262144$old$,
	$new$	if p_tool_catalog_text is null or octet_length(p_tool_catalog_text) not between 1 and 1048576$new$);

-- Nothing that runs may still name the machine limit.
do $$
declare v_name text;
begin
	for v_name in select procedure.oid::regprocedure::text from pg_proc procedure
		join pg_namespace namespace on namespace.oid = procedure.pronamespace
		where namespace.nspname = 'public'
			and (procedure.prosrc like '%qorpera_company_machine_limits%'
				or procedure.prosrc like '%machine-capacity/v1%'
				or procedure.prosrc like '%company_ceiling_tripped%')
	loop
		raise exception 'Function % still names the removed machine limit', v_name;
	end loop;
end
$$;
