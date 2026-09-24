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

-- Replaces a check constraint only when it still holds the bound being removed,
-- so a live schema that differs fails the migration instead of losing another check.
create function pg_temp.cap_replace_check(p_table regclass, p_name text, p_old text, p_new text)
returns void language plpgsql as $$
declare v_definition text;
begin
	select pg_get_constraintdef(oid) into v_definition from pg_constraint where conrelid = p_table and conname = p_name;
	if v_definition is null or position(p_old in v_definition) = 0 then
		raise exception 'Cap removal differs: % on % is %', p_name, p_table, coalesce(v_definition, 'missing'); end if;
	execute format('alter table %s drop constraint %I, add constraint %I check (%s)', p_table, p_name, p_name, p_new);
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

-- Counting a connection's held runs across every period needs its own index.
create index qorpera_execution_sponsor_reservations_held on public.qorpera_execution_sponsor_reservations(provider_connection_id)
	where status = 'reserved';

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
select pg_temp.cap_replace_check('public.qorpera_execution_runs', 'qorpera_execution_runs_check2',
	'24:00:00', 'deadline_at > created_at');
-- A run that no computer could start at all (no eligible node, identity home
-- or placement; admission refusals keep it queued) used to fail at its 24 h
-- deadline. It now fails after a day without its first acceptance, so it does
-- not hold its conversation and its account's concurrency forever. This bounds
-- waiting to start, never a run's work: an accepted run has no deadline.
select pg_temp.cap_patch('public.qorpera_reconcile_runner_orchestrator_without_sponsored_turns(uuid)'::regprocedure,
	$old$		last_error = 'Execution deadline expired before runner acceptance'
	from public.qorpera_execution_runs as run
	where job.id = run.job_id and job.status = 'queued'
		and run.deadline_at <= statement_timestamp()
		and job.id in (select candidate.id from public.qorpera_runner_jobs as candidate
			join public.qorpera_execution_runs as candidate_run on candidate_run.job_id = candidate.id
			where candidate.status = 'queued' and candidate_run.deadline_at <= statement_timestamp()
			order by candidate.id for update of candidate skip locked);$old$,
	$new$		last_error = 'No computer could start the run within a day'
	from public.qorpera_execution_runs as run
	where job.id = run.job_id and job.status = 'queued'
		and (run.deadline_at <= statement_timestamp()
			or (job.attempt_count = 0 and job.created_at <= statement_timestamp() - interval '24 hours'))
		and job.id in (select candidate.id from public.qorpera_runner_jobs as candidate
			join public.qorpera_execution_runs as candidate_run on candidate_run.job_id = candidate.id
			where candidate.status = 'queued' and (candidate_run.deadline_at <= statement_timestamp()
				or (candidate.attempt_count = 0 and candidate.created_at <= statement_timestamp() - interval '24 hours'))
			order by candidate.id for update of candidate skip locked);$new$);

-- A cut applies this with the runtime quiet (no queued or leased work), so no
-- open run keeps an old 24 h deadline; every run materialized after it gets
-- the new default.

select pg_temp.cap_replace_check('public.qorpera_native_provider_connection_leases',
	'qorpera_native_provider_connection_leases_check', '24:00:00', 'expires_at > created_at');

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
select pg_temp.cap_replace_check('public.qorpera_runner_usage_observations',
	'qorpera_runner_usage_observations_execution_ms_check', '86400000', 'execution_ms >= 1');
select pg_temp.cap_replace_check('public.qorpera_runner_usage_observations',
	'qorpera_runner_usage_observations_wall_time_limit_ms_check', '86400000', 'wall_time_limit_ms >= 10');

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
select pg_temp.cap_replace_check('public.qorpera_runtime_workers', 'qorpera_runtime_workers_sequence_check',
	'64', 'sequence >= 1');
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
select pg_temp.cap_replace_check('public.qorpera_native_execution_launches',
	'qorpera_native_execution_launches_tool_catalog_text_check', '262144',
	'octet_length(tool_catalog_text) between 1 and 1048576');
-- * A run reads and lists the Company File without a count (was 128 reads and
--   lists, and 128 distinct files held in its context). Every read is still
--   recorded, and every file in the run's context is still re-checked for read
--   access before each model request.
select pg_temp.cap_patch('public.qorpera_read_company_path_v2(uuid,text,integer,integer,jsonb)'::regprocedure,
	$old$	if (select count(*) from public.qorpera_company_read_observations where run_id = (v_actor ->> 'runId')::uuid) >= 128 then
		raise exception 'Read observation budget exceeded' using errcode = '54000'; end if;
$old$,
	'');
select pg_temp.cap_patch('public.qorpera_list_company_paths_v2(uuid,text,text,uuid,integer,jsonb)'::regprocedure,
	$old$	if (select count(*) from public.qorpera_company_read_observations where run_id = (v_actor ->> 'runId')::uuid) >= 128 then
		raise exception 'Read observation budget exceeded' using errcode = '54000'; end if;
$old$,
	'');
select pg_temp.cap_patch('public.qorpera_company_path_remember_read(jsonb,text)'::regprocedure,
	$old$	if (select count(*) from public.qorpera_company_run_read_paths where run_id = (p_actor ->> 'runId')::uuid) > 128 then
		raise exception 'Company File context read set is full' using errcode = '54000'; end if;
$old$,
	'');
select pg_temp.cap_patch('public.qorpera_assert_company_path_reads(uuid,jsonb,text[])'::regprocedure,
	$old$	if p_paths is null or cardinality(p_paths) > 128 then$old$,
	$new$	if p_paths is null then$new$);
-- * A run makes any number of model requests (was 256: one context view is
--   recorded per request). Each view is still recorded and checked. The 128
--   tool outputs one view may carry mirror the pinned Codex build and go with it.
select pg_temp.cap_patch('public.qorpera_record_native_context_view(uuid,jsonb,jsonb)'::regprocedure,
	$old$		if coalesce(v_ordinal,0) >= 256 then raise exception 'Context view budget exceeded' using errcode = '54000'; end if;
$old$,
	'');
select pg_temp.cap_replace_check('public.qorpera_native_context_views', 'qorpera_native_context_views_ordinal_check',
	'<= 256', 'ordinal >= 1');
-- * A run may hire any number of coworkers and open any number of group chats
--   (was 3 and 5 per run). Each is still a new agent or room this run proposed,
--   approved in the requesting member's name only when that member may approve.
select pg_temp.cap_patch('public.qorpera_self_approve_organization_proposal(jsonb,uuid)'::regprocedure,
	$old$	v_limit := case v_kind when 'agent' then 3 else 5 end;
	if (select count(*) from public.qorpera_company_path_proposals other
		where other.run_id = v_run.id and other.id <> v_proposal.id and other.status in ('approved','applied')
			and public.qorpera_agent_creatable_path_kind(other.plan ->> 'path') = v_kind) >= v_limit then
		raise exception 'This run reached its limit for new %s', v_kind || 's' using errcode = '54000'; end if;
$old$,
	'');
select pg_temp.cap_patch('public.qorpera_self_approve_organization_proposal(jsonb,uuid)'::regprocedure,
	$old$ v_role public.qorpera_profile_role; v_limit integer;$old$, $new$ v_role public.qorpera_profile_role;$new$);

-- ---------------------------------------------------------------------------
-- No limit on how many messages an agent sends or two agents exchange
-- ---------------------------------------------------------------------------
-- Jonas, told of the ping-pong risk: remove the send limits and the
-- agent-to-agent hop budget too. Nothing now stops two agents messaging each
-- other in a loop except a member's Stop (or the company pause).
-- * A wake's public sends: no count (was 64 for human, first-run and routine
--   wakes, 3 in rooms and worker continuations, 2 for a coworker's message in the
--   agent's thread). maxPublicSends is null ("no limit"), and 0 only where the
--   wake may not speak publicly at all (initial and final both forbidden): a
--   permission, not a count. The send and completion checks already treat null
--   as no limit.
select pg_temp.cap_patch('public.qorpera_wake_policy_value(text,text)'::regprocedure,
	$old$v_kind text; v_max integer := 64;$old$, $new$v_kind text; v_max integer;$new$);
select pg_temp.cap_patch('public.qorpera_wake_policy_value(text,text)'::regprocedure,
	$old$			v_initial := 'forbidden'; v_final := 'optional'; v_max := 2;$old$,
	$new$			v_initial := 'forbidden'; v_final := 'optional';$new$);
select pg_temp.cap_patch('public.qorpera_wake_policy_value(text,text)'::regprocedure,
	$old$			v_initial := 'optional'; v_final := 'optional'; v_max := 3;$old$,
	$new$			v_initial := 'optional'; v_final := 'optional';$new$);
select pg_temp.cap_patch('public.qorpera_wake_policy_value(text,text)'::regprocedure,
	$old$ else 'optional' end; v_max := 3;$old$,
	$new$ else 'optional' end;$new$);
-- * Coworker messages: no hop budget along a chain (was 6), no limit per pair per
--   hour (was 20) and no limit on the agents in a chain (was 16). A chain still
--   records its root and the agents it reached.
select pg_temp.cap_patch('public.qorpera_coworker_chain(uuid[],uuid,integer)'::regprocedure,
	$old$ or p_hops < 1 or p_hops > 6 then return null; end if;$old$,
	$new$ or p_hops < 1 then return null; end if;$new$);
select pg_temp.cap_patch('public.qorpera_coworker_chain(uuid[],uuid,integer)'::regprocedure,
	$old$	if cardinality(v_agents) > 16 then return null; end if;
$old$, '');
select pg_temp.cap_patch('public.qorpera_coworker_wake_ancestry(public.qorpera_wake_occurrences)'::regprocedure,
	$old$cardinality(v_parent.causal_agent_ids) not between 1 and 16$old$,
	$new$cardinality(v_parent.causal_agent_ids) < 1$new$);
select pg_temp.cap_patch('public.qorpera_coworker_wake_ancestry(public.qorpera_wake_occurrences)'::regprocedure,
	$old$		v_agents := v_agents || p_wake.staff_agent_id;
		if cardinality(v_agents) > 16 then return null; end if;$old$,
	$new$		v_agents := v_agents || p_wake.staff_agent_id;$new$);
select pg_temp.cap_patch('public.qorpera_send_coworker_message(jsonb,uuid,text,text,boolean)'::regprocedure,
	$old$		when v_priority and v_hops > 6 then 'This exchange paused after ' || (v_hops - 1)::text || ' messages. A member can continue it by writing to either agent.'
		when v_hourly >= 20 then 'These two agents have exchanged ' || v_hourly::text || ' messages this hour and are paused until it passes.'
$old$, '');
select pg_temp.cap_patch('public.qorpera_send_coworker_message(jsonb,uuid,text,text,boolean)'::regprocedure,
	$old$	select (select count(*) from public.qorpera_wake_occurrences
			where profile_id = v_run.profile_id and source_kind = 'coworker' and v_pair is not null
				and payload ->> 'pairSessionId' = v_pair::text and created_at > clock_timestamp() - interval '1 hour')
		+ (select count(*) from public.qorpera_pending_peer_messages
			where profile_id = v_run.profile_id and v_pair is not null and pair_session_id = v_pair
				and created_at > clock_timestamp() - interval '1 hour')
	into v_hourly;
$old$, '');
select pg_temp.cap_patch('public.qorpera_send_coworker_message(jsonb,uuid,text,text,boolean)'::regprocedure,
	$old$v_hops integer; v_hourly integer;$old$, $new$v_hops integer;$new$);
select pg_temp.cap_replace_check('public.qorpera_wake_occurrences', 'qorpera_wake_causal_bound',
	'<= 16', 'public.qorpera_uuid_array_is_unique(causal_agent_ids)');
select pg_temp.cap_replace_check('public.qorpera_wake_occurrences', 'qorpera_wake_occurrences_causal_hop_count_check',
	'<= 64', 'causal_hop_count >= 0');

-- Last, because dropping the limit table locks auth.users and qorpera_profiles
-- (its foreign keys) until the migration commits.
drop function public.qorpera_set_company_machine_limit(uuid,integer,bigint);
drop function public.qorpera_company_machine_capacity(uuid);
drop table public.qorpera_company_machine_limits;

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
