-- @fixture 924_folder_runtime_base.test.sql until "-- The checks start here"
-- A run with no progress for 30 minutes ends by itself, as a worker's Stop ends it (migration 20260930618000), unless it
-- has a reason to be quiet. Clocks are moved back by hand (the replica role skips the rows' guards).

select pg_temp.base_commit(pg_temp.base_owner(), 'stop-routine', jsonb_build_array(
	pg_temp.base_write('QorperaOS/agents/bob/routines/tick.md', 'routine', E'---\ntitle: Tick\n---\nLook at the numbers.\n',
		jsonb_build_object('kind', 'routine', 'id', '97500000-0000-4000-8000-0000000000e1', 'title', 'Tick', 'status', 'active',
			'trigger', jsonb_build_object('when', 'every', 'minutes', 60, 'starts', null), 'timezone', null, 'ends', null,
			'runs', null, 'quiet', null, 'effort', 'medium', 'reply', 'required', 'conclusion', null,
			'instructions', 'Look at the numbers.')))) \g /dev/null
do $$
declare v_routine public.qorpera_cloud_routines%rowtype; v_wake jsonb; v_pass jsonb; v_run uuid;
	v_at timestamptz := date_trunc('milliseconds', clock_timestamp()) - interval '1 minute';
begin
	perform pg_temp.base_claims('service_role');
	select * into strict v_routine from public.qorpera_cloud_routines where id = '97500000-0000-4000-8000-0000000000e1';
	v_wake := public.qorpera_enqueue_routine_wake(v_routine.id, v_routine.current_version, extensions.gen_random_uuid(),
		'stop-1', 'file', v_at, null, v_at + interval '1 hour');
	v_pass := pg_temp.base_materialize();
	v_run := (v_pass -> 'run_ids' ->> 0)::uuid;
	perform pg_temp.base_start(v_run);
	perform set_config('qorpera_test.stop_run', v_run::text, true);
end
$$;
select pg_temp.base_claims('service_role');

create function pg_temp.sr_run() returns uuid language sql as $$
	select current_setting('qorpera_test.stop_run')::uuid
$$;
create function pg_temp.sr_job() returns public.qorpera_runner_jobs language sql as $$
	select job from public.qorpera_runner_jobs as job
	where job.id = (select job_id from public.qorpera_execution_runs where id = pg_temp.sr_run())
$$;
-- Moves the run's whole clock back: its job's start, its assignments, its context views and its observations.
create function pg_temp.sr_age(p_minutes integer) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	update public.qorpera_runner_jobs set started_at = started_at - make_interval(mins => p_minutes)
	where id = (select job_id from public.qorpera_execution_runs where id = pg_temp.sr_run());
	update public.qorpera_runner_assignments set created_at = created_at - make_interval(mins => p_minutes)
	where run_id = pg_temp.sr_run();
	update public.qorpera_native_context_views set created_at = created_at - make_interval(mins => p_minutes)
	where run_id = pg_temp.sr_run();
	update public.qorpera_runtime_observations set ingested_at = ingested_at - make_interval(mins => p_minutes)
	where run_id = pg_temp.sr_run();
	set local session_replication_role = origin;
end
$$;
create function pg_temp.sr_observe(p_operation text, p_minutes integer) returns void language sql as $$
	insert into public.qorpera_runtime_observations(run_id, attempt_id, phase, assignment_id, operation, observed_at,
		ingested_at, observation)
	values (pg_temp.sr_run(), extensions.gen_random_uuid(), 'finish', (pg_temp.sr_job()).client_lease_id,
		p_operation, clock_timestamp() - make_interval(mins => p_minutes),
		clock_timestamp() - make_interval(mins => p_minutes), '{}')
$$;
-- Asserts a pass stops nothing and the run stays leased.
create function pg_temp.sr_kept(p_what text) returns void language plpgsql as $$
declare v_pass jsonb := public.qorpera_stop_runs_without_progress();
begin
	if (v_pass ->> 'stopped')::integer <> 0 or (pg_temp.sr_job()).status <> 'leased' then
		raise exception '%: the run is kept: %', p_what, v_pass; end if;
end
$$;
-- A row with only what its table needs, foreign keys and guards aside.
create function pg_temp.sr_insert(p_table text, p_row jsonb) returns void language plpgsql as $$
begin
	set local session_replication_role = replica;
	-- Only the columns given, so the others take their defaults.
	execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)', p_table,
		(select string_agg(quote_ident(key), ', ') from jsonb_object_keys(p_row) as key),
		(select string_agg(quote_ident(key), ', ') from jsonb_object_keys(p_row) as key), p_table) using p_row;
	set local session_replication_role = origin;
end
$$;

-- A. A fresh run is kept, and so is one 29 minutes quiet.
select pg_temp.sr_kept('A fresh run');
select pg_temp.sr_age(29);
select pg_temp.sr_kept('29 minutes quiet');

-- B. Progress 20 minutes ago keeps a run started long ago; a "writing" pulse is no progress.
select pg_temp.sr_age(60);
select pg_temp.sr_observe('company_read', 20);
select pg_temp.sr_kept('Progress 20 minutes ago');
select pg_temp.sr_age(20);
select pg_temp.sr_observe('message_composition', 0);

-- C. Silent now. Each reason to be quiet keeps it, and goes again; a reason too old keeps it no longer.
do $$
declare
	v_run uuid := pg_temp.sr_run();
	v_job public.qorpera_runner_jobs := pg_temp.sr_job();
	v_user uuid := '92400000-0000-4000-8000-000000000001';
	v_agent uuid := '92400000-0000-4000-8000-000000000031';
	v_machine uuid := extensions.gen_random_uuid();
	v_now timestamptz := clock_timestamp();
begin
	if not public.qorpera_run_last_progress_at(v_run, v_job.started_at) <= v_now - interval '30 minutes' then
		raise exception 'C: the run is silent'; end if;
	-- A machine it started is waiting for its place.
	perform pg_temp.sr_insert('qorpera_company_machines', jsonb_build_object('id', v_machine, 'profile_id', v_job.profile_id,
		'environment_id', v_job.environment_id, 'name', 'render', 'purpose', 'render', 'started_by_staff_agent_id', v_agent,
		'started_by_run_id', v_run, 'started_by_receipt_id', extensions.gen_random_uuid(), 'requested_by_user_id', v_user,
		'cpus', 2, 'memory_bytes', 4294967296, 'disk_bytes', 42949672960, 'image', 'standard', 'lifetime', 'task',
		'desired_state', 'running', 'wanted_at', v_now));
	perform pg_temp.sr_kept('A machine waiting for its place');
	set local session_replication_role = replica;
	update public.qorpera_company_machines set wanted_at = v_now - interval '7 hours' where id = v_machine;
	set local session_replication_role = origin;
	-- Its own command is running, on that machine.
	perform pg_temp.sr_insert('qorpera_company_machine_commands', jsonb_build_object('id', extensions.gen_random_uuid(),
		'machine_id', v_machine, 'run_id', v_run, 'staff_agent_id', v_agent, 'placement_id', extensions.gen_random_uuid(),
		'command_head', 'make', 'notify', false, 'requested_by_user_id', v_user, 'started_at', v_now));
	perform pg_temp.sr_kept('Its own command running');
	set local session_replication_role = replica;
	update public.qorpera_company_machine_commands set started_at = v_now - interval '7 hours' where run_id = v_run;
	set local session_replication_role = origin;
	-- A member must answer its call's review.
	perform pg_temp.sr_insert('qorpera_action_reviews', jsonb_build_object('id', extensions.gen_random_uuid(),
		'profile_id', v_job.profile_id, 'run_id', v_run, 'call_id', 'c1', 'staff_agent_id', v_agent, 'tool_name', 'x',
		'effect', 'external', 'argument_sha256', repeat('0', 64), 'action', '{}'::jsonb, 'decision', 'ask', 'approver_scope', 'owners_admins', 'built_in', 'none',
		'reason', 'x', 'reviewer_model', 'x', 'parked_at', v_now, 'created_at', v_now));
	perform pg_temp.sr_kept('A parked review');
	set local session_replication_role = replica;
	update public.qorpera_action_reviews set answer = 'deny', answered_at = v_now where run_id = v_run;
	set local session_replication_role = origin;
	-- Its login reached a usage limit.
	perform pg_temp.sr_insert('qorpera_provider_connection_usage_signals', jsonb_build_object('id', extensions.gen_random_uuid(),
		'profile_id', v_job.profile_id, 'run_id', v_run, 'job_id', v_job.id, 'sponsor_binding_id', extensions.gen_random_uuid(),
		'sponsor_version', 1, 'provider_connection_id', extensions.gen_random_uuid(), 'provider_connection_version', 1,
		'provider', 'openai', 'signal_kind', 'usage_limit', 'source', 'native_adapter', 'observed_at', v_now));
	perform pg_temp.sr_kept('A usage limit');
	delete from public.qorpera_provider_connection_usage_signals where run_id = v_run;
end
$$;

-- D. More silent runs at once than a pass stops: its observations more likely stopped than its runs hung.
do $$
declare v_pass jsonb := public.qorpera_stop_runs_without_progress(0);
begin
	if v_pass ->> 'held' <> 'true' or (v_pass ->> 'stopped')::integer <> 0 or (pg_temp.sr_job()).status <> 'leased' then
		raise exception 'D: a pass holds: %', v_pass; end if;
end
$$;

-- E. No reason left: the run ends as a Stop ends it, with its reason; a second pass finds nothing.
do $$
declare v_pass jsonb := public.qorpera_stop_runs_without_progress(); v_job public.qorpera_runner_jobs := pg_temp.sr_job();
begin
	if (v_pass ->> 'stopped')::integer <> 1 or v_job.status <> 'cancelled'
		or v_job.last_error not like 'Runner job made no progress for 30 minutes and was stopped%' then
		raise exception 'E: the run is stopped: % %, %', v_pass, v_job.status, v_job.last_error; end if;
	if not exists (select 1 from public.qorpera_runner_audit_receipts as audit
			where audit.job_id = v_job.id and audit.event_type = 'job_cancelled' and audit.payload ->> 'reason' = 'no_progress') then
		raise exception 'E: the stop is in the audit'; end if;
	if exists (select 1 from public.qorpera_stopped_chains where stopped_run_id = pg_temp.sr_run()) then
		raise exception 'E: it stops no chain'; end if;
	v_pass := public.qorpera_stop_runs_without_progress();
	if (v_pass ->> 'stopped')::integer <> 0 then raise exception 'E: a second pass finds nothing: %', v_pass; end if;
end
$$;

-- F. Nobody may call it from outside.
do $$
begin
	if has_function_privilege('authenticated', 'public.qorpera_stop_runs_without_progress(integer)', 'execute')
		or has_function_privilege('service_role', 'public.qorpera_stop_runs_without_progress(integer)', 'execute')
		or has_function_privilege('anon', 'public.qorpera_run_quiet_for_a_reason(uuid)', 'execute') then
		raise exception 'F: the pass is internal'; end if;
end
$$;
